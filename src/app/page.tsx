'use client';

import { useState, useRef } from 'react';
import Image from 'next/image';
import { 
  LinkData,
  SecurityReport,
  analyzeSecurityHeaders,
  computeAggregateSecurityReport,
  generateCSV,
  generateSummaryCSV,
  downloadCSV,
  cacheHitConditions,
  computeSummaryStats,
} from '@/lib/utils';

type ThrottlingEvent = {
  type: 'retry-after' | 'backoff';
  waitTime: number;
  resumeDelay: number;
};

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [crawling, setCrawling] = useState(false);
  const [fetchingInProgress, setFetchingInProgress] = useState(false);
  const [totalLinks, setTotalLinks] = useState(0);
  const [fetchedCount, setFetchedCount] = useState(0);
  const [links, setLinks] = useState<LinkData[]>([]);
  const [error, setError] = useState('');
  const [captureBody, setCaptureBody] = useState(false);
  const [selectedBodyIndex, setSelectedBodyIndex] = useState<number | null>(null);
  const [manualDelay, setManualDelay] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [throttlingMessage, setThrottlingMessage] = useState('');
  const [crawlStartTime, setCrawlStartTime] = useState<number | null>(null);
  const [crawlEndTime, setCrawlEndTime] = useState<number | null>(null);
  const [throttlingEvents, setThrottlingEvents] = useState<ThrottlingEvent[]>([]);
  const [wasStopped, setWasStopped] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [securitySummary, setSecuritySummary] = useState<SecurityReport | null>(null);

  const handleCrawl = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    setCrawling(true);
    setCrawlStartTime(Date.now());
    setCrawlEndTime(null);
    setThrottlingEvents([]);
    setSecuritySummary(null);
    setWasStopped(false);

    try {
      // support multiple seed URLs separated by commas or whitespace
      const seeds = url
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);

      if (seeds.length === 0) {
        setError('Please provide at least one URL');
        setLoading(false);
        setCrawling(false);
        return;
      }

      // validate seeds
      for (const s of seeds) {
        try {
          // eslint-disable-next-line no-new
          new URL(s);
        } catch (err) {
          setError(`Invalid URL: ${s}`);
          setLoading(false);
          setCrawling(false);
          return;
        }
      }

      // fetch crawl results for each seed concurrently
      const crawlPromises = seeds.map((seed) =>
        fetch('/api/crawl', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: seed }),
        }).then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to crawl URL');
          return data;
        })
      );

      const settled = await Promise.allSettled(crawlPromises);

      const linkOrigins = new Map<string, { originPage: string; selector?: string; text?: string }>();
      let reportedTotal = 0;

      settled.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          const value: any = r.value;
          if (Array.isArray(value.links)) {
            value.links.forEach((link: any) => {
              if (!linkOrigins.has(link.url)) {
                linkOrigins.set(link.url, {
                  originPage: link.originPage,
                  selector: link.selector,
                  text: link.text,
                });
              }
            });
            reportedTotal += value.totalLinks || value.links.length;
          }
        } else {
          // if a seed failed, append an error message but continue with others
          console.warn('Crawl failed for seed', seeds[idx], r.reason);
        }
      });

      // Get unique links
      const unique = Array.from(linkOrigins.keys());

      setTotalLinks(unique.length);
      setLinks([]);
      setFetchedCount(0);
      setCrawling(false);

      // Start fetching headers for unique links
      await fetchAllHeaders(unique, linkOrigins);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setLoading(false);
      setCrawling(false);
    }
  };

  const fetchAllHeaders = async (linkUrls: string[], linkOrigins: Map<string, { originPage: string; selector?: string; text?: string }>) => {
    setFetchingInProgress(true);
    abortControllerRef.current = new AbortController();
    setThrottlingMessage('');
    setRecoveryMessage('');
    setThrottlingEvents([]);

    const newLinks: LinkData[] = [];
    const events: Array<{ type: 'retry-after' | 'backoff'; waitTime: number; resumeDelay: number }> = [];
    const baselineDelay = manualDelay * 1000; // Convert to milliseconds
    let currentDelay = baselineDelay; // Start with baseline
    let backoffCount = 0; // Track backoff level for exponential calculation
    let successfulRequestsSinceThrottle = 0; // Track recovery progress
    let isRecovering = false; // Track if we're in recovery mode
    let recoveryStartDelay = 0; // Remember the delay when recovery started

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    for (let i = 0; i < linkUrls.length; i++) {
      if (abortControllerRef.current.signal.aborted) {
        break;
      }

      // Apply manual or adaptive delay
      if (i > 0) {
        await sleep(currentDelay);
      }

      const linkUrl = linkUrls[i];
      try {
        const startTime = performance.now();
        const response = await fetch('/api/fetch-headers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: linkUrl, captureBody }),
          signal: abortControllerRef.current.signal,
        });
        const endTime = performance.now();
        const responseTime = Math.round(endTime - startTime);

        const data = await response.json();

        // Handle 429 (Too Many Requests) with intelligent backoff
        if (data.status === 429) {
          const retryAfter = data.headers?.['retry-after'] || data.headers?.['Retry-After'];
          let waitTime = 0;
          let additionalDelay = 0;
          let statusMsg = '';
          let eventType: 'retry-after' | 'backoff' = 'backoff';

          if (retryAfter) {
            // Use Retry-After header if available
            const retryAfterMs = isNaN(parseInt(retryAfter))
              ? new Date(retryAfter).getTime() - Date.now()
              : parseInt(retryAfter) * 1000;
            waitTime = Math.max(0, retryAfterMs);
            additionalDelay = (backoffCount + 1) * 1000; // 1s, 2s, 3s, ... based on backoff count
            statusMsg = `⏸️ Rate limited (429). Respecting Retry-After header: waiting ${(waitTime / 1000).toFixed(1)}s. Will resume at ${(additionalDelay / 1000).toFixed(1)}s delay between links.`;
            eventType = 'retry-after';
          } else {
            // Exponential backoff: 5s, 10s, 20s, 40s, etc.
            waitTime = 5000 * Math.pow(2, backoffCount);
            additionalDelay = (backoffCount + 1) * 1000; // 1s, 2s, 3s, ... based on backoff count
            statusMsg = `⏸️ Rate limited (429). Starting exponential backoff: pausing for ${(waitTime / 1000).toFixed(1)}s. Will resume at ${(additionalDelay / 1000).toFixed(1)}s delay between links.`;
            eventType = 'backoff';
            backoffCount++; // Increment for next 429
          }

          events.push({ type: eventType, waitTime, resumeDelay: additionalDelay });
          setThrottlingEvents([...events]);
          setThrottlingMessage(statusMsg);

          // Pause and wait
          if (waitTime > 0) {
            console.log(`Rate limited (429). Waiting ${waitTime}ms before resuming...`);
            await sleep(waitTime);
          }

          // Update the delay for future requests (apply backoff reduction)
          if (currentDelay > 0) {
            // Manual delay mode: apply 50% reduction on next 429
            currentDelay = (currentDelay + additionalDelay) * 0.5;
          } else {
            // Automatic mode: use the additional delay
            currentDelay = additionalDelay;
            backoffCount = 0; // Reset for next backoff sequence
          }

          // Start recovery mode
          isRecovering = true;
          recoveryStartDelay = currentDelay;
          successfulRequestsSinceThrottle = 0;
          setRecoveryMessage('');

          setThrottlingMessage('');
        } else if (data.status === 200 || (data.status >= 300 && data.status < 429) || data.status > 429) {
          // Successful or error response (not 429)
          if (isRecovering && currentDelay > baselineDelay) {
            successfulRequestsSinceThrottle++;
            
            // Gradually recover: reduce delay by 10% every 5 successful requests
            if (successfulRequestsSinceThrottle % 5 === 0) {
              const previousDelay = currentDelay;
              currentDelay = Math.max(baselineDelay, currentDelay * 0.9);
              const recoveryPercent = Math.round(((recoveryStartDelay - currentDelay) / (recoveryStartDelay - baselineDelay)) * 100);
              setRecoveryMessage(`📈 Recovering speed... ${recoveryPercent}% (${successfulRequestsSinceThrottle} successful requests)`);
            }

            // Full recovery achieved
            if (currentDelay <= baselineDelay + 1) { // +1 for floating point tolerance
              currentDelay = baselineDelay;
              isRecovering = false;
              successfulRequestsSinceThrottle = 0;
              setRecoveryMessage('✅ Speed fully recovered to baseline');
              setTimeout(() => setRecoveryMessage(''), 3000); // Clear message after 3 seconds
            }
          } else {
            // Not in recovery or already back to baseline
            backoffCount = 0;
            if (currentDelay === 0) {
              currentDelay = 0;
            }
          }
          setThrottlingMessage('');
        }

        const hit = cacheHitConditions(data).some(Boolean);
        const securityReport = analyzeSecurityHeaders(data.headers || {});
        const origin = linkOrigins.get(data.url);

        const linkData: LinkData = {
          url: data.url,
          status: data.status,
          statusText: data.statusText,
          contentLength: data.headers['content-length'],
          hit: hit ? true : false,
          headers: data.headers || {},
          body: data.body || undefined,
          error: data.error || '',
          responseTime,
          securityReport,
          originPage: origin?.originPage,
          selector: origin?.selector,
          linkText: origin?.text,
        };

        newLinks.push(linkData);
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) {
          newLinks.push({
            url: linkUrl,
            status: 0,
            statusText: 'Request Failed',
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      }

      setFetchedCount(i + 1);
      setLinks([...newLinks]);
      setSecuritySummary(computeAggregateSecurityReport(newLinks.map((link) => link.securityReport!).filter(Boolean)));
    }

    setFetchingInProgress(false);
    setLoading(false);
    setThrottlingMessage('');
    setCrawlEndTime(Date.now());
    setThrottlingEvents([...events]);
    setRecoveryMessage('');
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setFetchingInProgress(false);
      setLoading(false);
      setCrawlEndTime(Date.now());
      setWasStopped(true);
    }
  };

  const handleDownloadCSV = () => {
    const csvContent = generateCSV(links, totalLinks);
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${url}-link-report-${dateStr}.csv`;
    downloadCSV(csvContent, filename);
  };

  const handleDownloadSummary = () => {
    const csvContent = generateSummaryCSV(links, totalLinks);
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${url}-summary-report-${dateStr}.csv`;
    downloadCSV(csvContent, filename);
  };

  const progressPercentage = totalLinks > 0 ? (fetchedCount / totalLinks) * 100 : 0;

  // compute summary stats for rendering and downloads
  const summaryStats = computeSummaryStats(links, totalLinks);
  const { count200, count4xx, count5xx, countOther, cacheHit, cacheMiss, errors } = summaryStats;
  const cacheHitRate = cacheHit + cacheMiss > 0 ? (cacheHit / (cacheHit + cacheMiss)) * 100 : 0;
  const cacheHitRateDisplay = cacheHitRate.toFixed(2);
  const cacheHitRateClass =
    cacheHitRate > 80
      ? 'bg-green-200 text-green-800'
      : cacheHitRate < 40
      ? 'bg-red-200 text-red-800'
      : 'bg-yellow-200 text-yellow-800';

  const avgResponseTime = links.length > 0 ? Math.round(links.reduce((sum, link) => sum + (link.responseTime || 0), 0) / links.length) : 0;
  const avgResponseTimeClass =
    avgResponseTime > 1000
      ? 'bg-red-200 text-red-800'
      : avgResponseTime < 300
      ? 'bg-green-200 text-green-800'
      : 'bg-orange-200 text-orange-800';
  
  const medianResponseTime = links.length > 0 ? (() => {
    const times = links.map(link => link.responseTime || 0).sort((a, b) => a - b);
    const mid = Math.floor(times.length / 2);
    return times.length % 2 !== 0 ? times[mid] : Math.round((times[mid - 1] + times[mid]) / 2);
  })() : 0;
  const medianResponseTimeClass =
    medianResponseTime > 1000
      ? 'bg-red-200 text-red-800'
      : medianResponseTime < 300
      ? 'bg-green-200 text-green-800'
      : 'bg-orange-200 text-orange-800';

  const median200ResponseTime = count200 > 0 ? (() => {
    const times200 = links
      .filter(link => link.status === 200)
      .map(link => link.responseTime || 0)
      .sort((a, b) => a - b);
    const mid = Math.floor(times200.length / 2);
    return times200.length % 2 !== 0 ? times200[mid] : Math.round((times200[mid - 1] + times200[mid]) / 2);
  })() : 0;
  const median200ResponseTimeClass =
    median200ResponseTime > 1000
      ? 'bg-red-200 text-red-800'
      : median200ResponseTime < 300
      ? 'bg-green-200 text-green-800'
      : 'bg-orange-200 text-orange-800';

  const medianCacheHitResponseTime = cacheHit > 0 ? (() => {
    const timesCacheHit = links
      .filter(link => link.hit === true)
      .map(link => link.responseTime || 0)
      .sort((a, b) => a - b);
    const mid = Math.floor(timesCacheHit.length / 2);
    return timesCacheHit.length % 2 !== 0 ? timesCacheHit[mid] : Math.round((timesCacheHit[mid - 1] + timesCacheHit[mid]) / 2);
  })() : 0;
  const medianCacheHitResponseTimeClass =
    medianCacheHitResponseTime > 1000
      ? 'bg-red-200 text-red-800'
      : medianCacheHitResponseTime < 300
      ? 'bg-green-200 text-green-800'
      : 'bg-orange-200 text-orange-800';

  const medianCacheMissResponseTime = cacheMiss > 0 ? (() => {
    const timesCacheMiss = links
      .filter(link => link.hit === false)
      .map(link => link.responseTime || 0)
      .sort((a, b) => a - b);
    const mid = Math.floor(timesCacheMiss.length / 2);
    return timesCacheMiss.length % 2 !== 0 ? timesCacheMiss[mid] : Math.round((timesCacheMiss[mid - 1] + timesCacheMiss[mid]) / 2);
  })() : 0;
  const medianCacheMissResponseTimeClass =
    medianCacheMissResponseTime > 1000
      ? 'bg-red-200 text-red-800'
      : medianCacheMissResponseTime < 300
      ? 'bg-green-200 text-green-800'
      : 'bg-orange-200 text-orange-800';

  // Group errors by status code
  const errorsByCode = errors.reduce((acc, err) => {
    if (!acc[err.code]) {
      acc[err.code] = 0;
    }
    acc[err.code]++;
    return acc;
  }, {} as Record<number, number>);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <div className="mb-8 flex items-center gap-4">
            <div className="">
                <h1 className="text-4xl font-bold text-gray-800 mb-2">Crawler Monkey</h1>
                <p className="text-gray-600 mb-8">
                Crawls a website, fetches all same-domain links, and stores their response headers, showing the 4xx and 5xx errors, Cache Hit Rate and average response times.  
                <br/>
                Enter one or more URLs to get started (e.g. Home, PLP, PDP). 
                <br/>
                You can also choose to capture the response body for HTML preview. 
                <br/>
                After crawling, download a summary or detailed CSV reports for further analysis. 
              </p>
          </div>
          <Image
              src={"/crawler_monkey.png"}
              alt="Crawler Monkey Logo"
              className="rounded-full"
              width="200"
              height="200"
            />
          </div>


          {/* Input Form */}
          <form onSubmit={handleCrawl} className="mb-8">
            <div className="space-y-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com or multiple URLs separated by commas/spaces"
                  disabled={loading}
                  className="text-gray-800 flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-100"
                  required
                />
                <button
                  type="submit"
                  disabled={loading || !url}
                  className="px-6 py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:bg-gray-400 transition"
                >
                  {loading ? 'Processing...' : 'Start Crawl'}
                </button>
              </div>

              {/* Capture Body Checkbox */}
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={captureBody}
                  onChange={(e) => setCaptureBody(e.target.checked)}
                  disabled={loading}
                  className="w-4 h-4 text-indigo-600 rounded focus:ring-2 focus:ring-indigo-500"
                />
                <span className="text-gray-700 font-medium">
                  Capture response body (allows HTML preview)
                </span>
              </label>

              {/* Manual Delay Slider */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <label className="text-gray-700 font-medium">
                    Manual Delay Between Requests: {(manualDelay * 100).toFixed(0)}ms
                  </label>
                  {manualDelay === 0 ? (
                    <span className="inline-block px-3 py-1 bg-green-100 text-green-800 text-xs font-semibold rounded-full">
                      🤖 Intelligent Throttling ON
                    </span>
                  ) : (
                    <span className="inline-block px-3 py-1 bg-blue-100 text-blue-800 text-xs font-semibold rounded-full">
                      ⚙️ Manual Throttling
                    </span>
                  )}
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  step="1"
                  value={manualDelay * 10}
                  onChange={(e) => setManualDelay(parseInt(e.target.value) / 10)}
                  disabled={loading}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                />
                <p className="text-xs text-gray-500">
                  Use this to manually throttle the crawl speed. Leave at 0ms for automatic intelligent speed control.
                </p>
              </div>
            </div>
          </form>

          {/* Error Message */}
          {error && (
            <div className="mb-8 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
              {error}
            </div>
          )}

          {/* Progress Bar and Stats */}
          {(crawling || fetchingInProgress) && (
            <div className="mb-8 space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm font-medium text-gray-700">
                  <span>{crawling ? 'Crawling links...' : 'Fetching headers...'}</span>
                  <span>
                    {fetchedCount} / {totalLinks}
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-indigo-600 h-full transition-all duration-300"
                    style={{ width: `${progressPercentage}%` }}
                  />
                </div>
              </div>

              {throttlingMessage && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
                  {throttlingMessage}
                </div>
              )}

              {recoveryMessage && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-blue-800 text-sm">
                  {recoveryMessage}
                </div>
              )}

              {fetchingInProgress && (
                <button
                  onClick={handleStop}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 transition"
                >
                  Stop
                </button>
              )}
            </div>
          )}

          {/* Crawl Report */}
          {(crawlEndTime && !loading && !fetchingInProgress) && (
            <div className="mb-8 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <h3 className="text-lg font-bold text-blue-900 mb-3">📊 Crawl Report</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-blue-700 font-semibold">Total Time</p>
                  <p className="text-blue-900">
                    {crawlStartTime && crawlEndTime ? `${((crawlEndTime - crawlStartTime) / 1000).toFixed(1)}s` : 'N/A'}
                  </p>
                </div>
                <div>
                  <p className="text-blue-700 font-semibold">Status</p>
                  <p className="text-blue-900">
                    {wasStopped ? '⏹️ Stopped' : '✅ Completed'}
                  </p>
                </div>
                <div>
                  <p className="text-blue-700 font-semibold">Rate Limit Events</p>
                  <p className="text-blue-900">{throttlingEvents.length} (429) encountered</p>
                </div>
                {throttlingEvents.length > 0 && (
                  <div>
                    <p className="text-blue-700 font-semibold">Pause Duration</p>
                    <p className="text-blue-900">
                      {(throttlingEvents.reduce((sum: number, e: ThrottlingEvent) => sum + e.waitTime, 0) / 1000).toFixed(1)}s total
                    </p>
                  </div>
                )}
              </div>
              {throttlingEvents.length > 0 && (
                <details className="mt-3 cursor-pointer">
                  <summary className="text-blue-600 hover:text-blue-800 font-semibold">
                    View Throttling Details ({throttlingEvents.length})
                  </summary>
                  <div className="mt-2 bg-white p-3 rounded border border-blue-200 space-y-2">
                    {throttlingEvents.map((event: ThrottlingEvent, idx: number) => (
                      <div key={idx} className="text-sm text-blue-800 py-1 border-b border-blue-100 last:border-b-0">
                        <span className="font-semibold">Event {idx + 1}:</span> {event.type === 'retry-after' ? '⏸️ Retry-After' : '📈 Exponential Backoff'}
                        {' '} - Paused {(event.waitTime / 1000).toFixed(1)}s, resumed at {(event.resumeDelay / 1000).toFixed(1)}s delay
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          {/* Results Section */}
          {links.length > 0 && (
            <>
              {/* Summary Section */}
              <h1 className="block text-2xl font-bold text-gray-800">Crawling Summary</h1>
              <div className="mb-6 flex flex-wrap gap-6 items-center">
                <>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-green-700">{count200}</span>
                    <span className="text-gray-700">/ {totalLinks} links are <span className="font-bold">200 OK</span></span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-yellow-700">{count4xx}</span>
                    <span className="text-gray-700">/ {totalLinks} are <span className="font-bold">4xx Errors</span></span>
                    {count4xx > 0 && (
                      <details className="ml-2">
                        <summary className="inline-flex items-center cursor-pointer text-blue-600 hover:underline">
                          <span className="bg-yellow-200 text-yellow-800 rounded-full px-2 py-0.5 text-xs font-bold mr-1">i</span>
                          Details
                        </summary>
                        <div className="mt-2 bg-white border border-gray-200 rounded p-2 text-xs text-gray-700 max-w-xs space-y-1">
                          {Object.entries(errorsByCode)
                            .filter(([code]) => parseInt(code) >= 400 && parseInt(code) < 500)
                            .map(([code, count]) => (
                              <div key={code} className="flex justify-between">
                                <span><span className="font-semibold">{count}x</span> {code}</span>
                              </div>
                            ))}
                        </div>
                      </details>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-red-700">{count5xx}</span>
                    <span className="text-gray-700">/ {totalLinks} are <span className="font-bold">5xx Errors</span></span>
                    {count5xx > 0 && (
                      <details className="ml-2">
                        <summary className="inline-flex items-center cursor-pointer text-red-600 hover:underline">
                          <span className="bg-red-200 text-red-800 rounded-full px-2 py-0.5 text-xs font-bold mr-1">i</span>
                          Details
                        </summary>
                        <div className="mt-2 bg-white border border-red-200 rounded p-2 text-xs text-red-700 max-w-xs space-y-1">
                          {Object.entries(errorsByCode)
                            .filter(([code]) => parseInt(code) >= 500 && parseInt(code) < 600)
                            .map(([code, count]) => (
                              <div key={code} className="flex justify-between">
                                <span><span className="font-semibold">{count}x</span> {code}</span>
                              </div>
                            ))}
                        </div>
                      </details>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-gray-700">{countOther}</span>
                    <span className="text-gray-700">other status</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-bold ${cacheHitRateClass}`}>{cacheHitRateDisplay}%</span>
                    <span className="text-gray-700">Cache Hit Rate</span>
                    {/* <span className="font-bold text-gray-700">{cacheMiss}</span>
                    <span className="text-gray-700">cache misses</span> */}
                  </div>
                  {securitySummary && (
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-indigo-700">{securitySummary.grade}</span>
                      <span className="text-gray-700">Security Headers Score</span>
                      <span className="text-sm text-gray-500">({securitySummary.present}/{securitySummary.total} present)</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <span className={`font-bold ${avgResponseTimeClass}`}>{avgResponseTime}ms</span>
                    <span className="text-gray-700">Average Response Time</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-bold ${medianResponseTimeClass}`}>{medianResponseTime}ms</span>
                    <span className="text-gray-700">Median Response Time</span>
                  </div>
                  {count200 > 0 && (
                    <div className="flex items-center gap-2">
                      <span className={`font-bold ${median200ResponseTimeClass}`}>{median200ResponseTime}ms</span>
                      <span className="text-gray-700">Median Response Time (200 OK)</span>
                    </div>
                  )}
                  {cacheHit > 0 && (
                    <>
                      <div className="flex items-center gap-2">
                        <span className={`font-bold ${medianCacheHitResponseTimeClass}`}>{medianCacheHitResponseTime}ms</span>
                        <span className="text-gray-700">Median Response Time (Cache Hits)</span>
                      </div>
                      {cacheMiss > 0 && (
                        <div className="flex items-center gap-2">
                          <span className={`font-bold ${medianCacheMissResponseTimeClass}`}>{medianCacheMissResponseTime}ms</span>
                          <span className="text-gray-700">Median Response Time (Cache Misses)</span>
                        </div>
                      )}
                    </>
                  )}
                </>
              </div>

              {securitySummary && (
                <div className="mb-6 p-4 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                    <div>
                      <h3 className="text-lg font-bold text-slate-900">Security Header Report</h3>
                      <p className="text-sm text-slate-600">
                        Scores the presence of essential 2026 security headers and explains what each protects against.
                      </p>
                    </div>
                    <div className="text-right">
                      <span className="text-2xl font-bold text-slate-900">{securitySummary.grade}</span>
                      <div className="text-sm text-slate-600">{securitySummary.score}%</div>
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-lg bg-white border border-slate-200 p-3">
                      <p className="text-sm font-semibold text-slate-800">Headers Present</p>
                      <p className="text-3xl font-bold text-slate-900">{securitySummary.present}</p>
                    </div>
                    <div className="rounded-lg bg-white border border-slate-200 p-3">
                      <p className="text-sm font-semibold text-slate-800">Headers Missing</p>
                      <p className="text-3xl font-bold text-red-700">{securitySummary.missing.length}</p>
                    </div>
                  </div>
                  {securitySummary.missing.length > 0 && (
                    <div className="mt-4">
                      <p className="text-sm font-semibold text-slate-800 mb-2">Missing Headers</p>
                      <div className="space-y-2">
                        {securitySummary.missing.map((header) => (
                          <div key={header.headerName} className="rounded-lg bg-white border border-red-100 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-slate-900">{header.headerName}</span>
                              <span className="text-xs font-semibold text-red-700 uppercase">{header.importance}</span>
                            </div>
                            <p className="text-sm text-slate-600 mt-1">{header.purpose}</p>
                            <div className="mt-2 text-xs text-slate-500">
                              Protects against: {header.protectsAgainst.join(', ')}
                            </div>
                            <div className="mt-2 text-xs text-slate-500">
                              Recommended: <span className="font-semibold">{header.recommendedValue}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Results Table */}
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <h2 className="text-2xl font-bold text-gray-800">
                    Results ({links.length} links)
                  </h2>
                  <div className="flex gap-2">
                    <button
                      onClick={handleDownloadCSV}
                      className="px-4 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 transition"
                    >
                      Download CSV
                    </button>
                    <button
                      onClick={handleDownloadSummary}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition"
                    >
                      Download Summary
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-gray-100 border-b border-gray-300">
                        <th className="px-4 py-2 text-left font-semibold text-gray-700">URL</th>
                        <th className="px-4 py-2 text-center font-semibold text-gray-700">Status</th>
                        <th className="px-4 py-2 text-center font-semibold text-gray-700">Content Length</th>
                        <th className="px-4 py-2 text-center font-semibold text-gray-700">Cache Hit</th>
                        <th className="px-4 py-2 text-center font-semibold text-gray-700">Response Time (ms)</th>
                        <th className="px-4 py-2 text-left font-semibold text-gray-700">Headers</th>
                        {links.some(link => (link.status >= 400 && link.status < 500 && link.status !== 429) || (link.status >= 500 && link.status < 600)) && (
                          <th className="px-4 py-2 text-left font-semibold text-gray-700">Origin</th>
                        )}
                        {captureBody && (
                          <th className="px-4 py-2 text-center font-semibold text-gray-700">Preview</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {links.map((link, index) => (
                        <tr
                          key={index}
                          className={`border-b border-gray-200 ${
                            link.status === 200
                              ? 'bg-green-50 hover:bg-green-100'
                              : link.error
                              ? 'bg-red-50 hover:bg-red-100'
                              : 'bg-yellow-50 hover:bg-yellow-100'
                          } transition`}
                        >
                          <td className="px-4 py-2">
                            <a
                              href={link.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-indigo-600 hover:underline truncate max-w-xs inline-block"
                              title={link.url}
                            >
                              {link.url}
                            </a>
                          </td>
                          <td className="px-4 py-2 text-center">
                            <span
                              className={`inline-block px-2 py-1 rounded font-bold ${
                                link.status === 200
                                  ? 'bg-green-200 text-green-800'
                                  : link.error
                                  ? 'bg-red-200 text-red-800'
                                  : 'bg-yellow-200 text-yellow-800'
                              }`}
                            >
                              {link.status || 'ERR'}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-center text-gray-600 text-xs">
                            {link.contentLength || '-'}
                          </td>
                          <td className="px-4 py-2 text-center">
                            <span
                              className={`inline-block px-2 py-1 rounded font-bold ${
                                link.hit
                                  ? 'bg-green-200 text-green-800'
                                  : link.error
                                  ? 'bg-red-200 text-red-800'
                                  : 'bg-yellow-200 text-yellow-800'
                              }`}
                            >
                              {link.hit ? 'HIT' : link.error ? 'ERROR' : 'MISS'}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-center text-gray-600 text-xs">
                            {link.responseTime ? `${link.responseTime}ms` : 'N/A'}
                          </td>
                          <td className="px-4 py-2 text-gray-600 text-xs">
                            <details className="cursor-pointer">
                              <summary className="font-semibold text-indigo-600 hover:text-indigo-700">
                                View Headers ({Object.keys(link.headers || {}).length})
                              </summary>
                              <div className="mt-2 bg-gray-50 p-2 rounded border border-gray-200 max-h-48 overflow-y-auto">
                                {Object.entries(link.headers || {}).length > 0 ? (
                                  <dl className="space-y-1">
                                    {Object.entries(link.headers || {}).map(([key, value]) => (
                                      <div key={key} className="border-b border-gray-200 pb-1 last:border-b-0">
                                        <dt className="font-semibold text-gray-700 inline">{key}:</dt>
                                        <dd className="text-gray-600 break-words text-xs ml-2 inline">{value}</dd>
                                      </div>
                                    ))}
                                  </dl>
                                ) : (
                                  <p className="text-gray-500">No headers available</p>
                                )}
                              </div>
                            </details>
                            {link.error && (
                              <p className="text-red-600 font-semibold mt-2">{link.error}</p>
                            )}
                          </td>
                          {links.some(link => (link.status >= 400 && link.status < 500 && link.status !== 429) || (link.status >= 500 && link.status < 600)) && (
                            <td className="px-4 py-2 text-gray-600 text-xs">
                              {((link.status >= 400 && link.status < 500 && link.status !== 429) || (link.status >= 500 && link.status < 600)) && link.originPage ? (
                                <details className="cursor-pointer">
                                  <summary className="font-semibold text-indigo-600 hover:text-indigo-700">
                                    View Origin
                                  </summary>
                                  <div className="mt-2 bg-gray-50 p-2 rounded border border-gray-200">
                                    <div className="space-y-1">
                                      <div>
                                        <span className="font-semibold text-gray-700">Page:</span>
                                        <a
                                          href={link.originPage}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-indigo-600 hover:underline ml-1 truncate max-w-xs inline-block"
                                          title={link.originPage}
                                        >
                                          {link.originPage}
                                        </a>
                                      </div>
                                      {link.selector && (
                                        <div>
                                          <span className="font-semibold text-gray-700">Selector:</span>
                                          <code className="text-xs bg-gray-200 px-1 py-0.5 rounded ml-1">{link.selector}</code>
                                        </div>
                                      )}
                                      {link.linkText && (
                                        <div>
                                          <span className="font-semibold text-gray-700">Text:</span>
                                          <span className="text-gray-600 ml-1 italic">"{link.linkText}"</span>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </details>
                              ) : (
                                <span className="text-gray-400">-</span>
                              )}
                            </td>
                          )}
                          {captureBody && (
                            <td className="px-4 py-2 text-center">
                              {link.body ? (
                                <button
                                  onClick={() => setSelectedBodyIndex(selectedBodyIndex === index ? null : index)}
                                  className="px-3 py-1 bg-blue-600 text-white rounded font-semibold hover:bg-blue-700 transition text-xs"
                                >
                                  {selectedBodyIndex === index ? 'Hide' : 'Show'} HTML
                                </button>
                              ) : (
                                <span className="text-gray-400 text-xs">No body</span>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {/* HTML Preview Modal */}
          {captureBody && selectedBodyIndex !== null && links[selectedBodyIndex]?.body && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
              <div className="bg-white rounded-lg shadow-2xl max-w-4xl w-full max-h-[80vh] flex flex-col">
                <div className="flex justify-between items-center p-6 border-b border-gray-200">
                  <h2 className="text-xl font-bold text-gray-800">HTML Preview</h2>
                  <button
                    onClick={() => setSelectedBodyIndex(null)}
                    className="text-gray-500 hover:text-gray-700 text-2xl font-bold"
                  >
                    ×
                  </button>
                </div>

                <div className="flex-1 overflow-hidden flex">
                  {/* HTML Source */}
                  <div className="flex-1 border-r border-gray-200 overflow-y-auto p-4 bg-gray-50">
                    <h3 className="font-semibold text-gray-700 mb-2">Source</h3>
                    <pre className="text-xs text-gray-600 whitespace-pre-wrap break-words font-mono max-h-96">
                      {links[selectedBodyIndex]?.body?.slice(0, 2000)}
                      {links[selectedBodyIndex]?.body?.length! > 2000 && (
                        <p className="text-blue-600 font-semibold mt-2">
                          ... (showing first 2000 characters of {links[selectedBodyIndex]?.body?.length} total)
                        </p>
                      )}
                    </pre>
                  </div>

                  {/* Rendered HTML */}
                  <div className="flex-1 overflow-y-auto p-4 bg-white">
                    <h3 className="font-semibold text-gray-700 mb-2">Rendered</h3>
                    <iframe
                      srcDoc={links[selectedBodyIndex]?.body}
                      className="w-full h-96 border border-gray-200 rounded"
                      title="HTML Preview"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* No results message */}
          {!loading && totalLinks === 0 && links.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              <p>Enter a URL and click "Start Crawl" to begin analyzing links</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
