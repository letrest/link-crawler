'use client';

import { useState, useRef } from 'react';
import { 
  LinkData,
  generateCSV,
  generateSummaryCSV,
  downloadCSV,
  cacheHitConditions,
  computeSummaryStats,
} from '@/lib/utils';

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
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleCrawl = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    setCrawling(true);

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

      let allLinks: string[] = [];
      let reportedTotal = 0;

      settled.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          const value: any = r.value;
          if (Array.isArray(value.links)) allLinks.push(...value.links);
          reportedTotal += value.totalLinks || (Array.isArray(value.links) ? value.links.length : 0);
        } else {
          // if a seed failed, append an error message but continue with others
          console.warn('Crawl failed for seed', seeds[idx], r.reason);
        }
      });

      // dedupe links
      const unique = Array.from(new Set(allLinks));

      setTotalLinks(unique.length);
      setLinks([]);
      setFetchedCount(0);
      setCrawling(false);

      // Start fetching headers for unique links
      await fetchAllHeaders(unique);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setLoading(false);
      setCrawling(false);
    }
  };

  const fetchAllHeaders = async (linkUrls: string[]) => {
    setFetchingInProgress(true);
    abortControllerRef.current = new AbortController();

    const newLinks: LinkData[] = [];

    for (let i = 0; i < linkUrls.length; i++) {
      if (abortControllerRef.current.signal.aborted) {
        break;
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

        const hit = cacheHitConditions(data).some(Boolean);

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
    }

    setFetchingInProgress(false);
    setLoading(false);
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setFetchingInProgress(false);
      setLoading(false);
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <h1 className="text-4xl font-bold text-gray-800 mb-2">Link Crawler</h1>
          <p className="text-gray-600 mb-8">
            Crawl a website, fetch all same-domain links, and analyze their headers, caching status, and response times.  
            <br/>
            Enter one or more URLs to get started (e.g. Home, PLP, PDP). 
            <br/>
            You can also choose to capture the response body for HTML preview. 
            <br/>
            After crawling, download detailed CSV reports for further analysis. 
          </p>

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

          {/* Results Section */}
          {links.length > 0 && (
            <>
              {/* Summary Section */}
              <h1 className="block text-2xl font-bold text-gray-800">Crawling Summary</h1>
              <div className="mb-6 flex flex-wrap gap-6 items-center">
                {(() => {
                  const avgResponseTime = links.length > 0 
                    ? Math.round(links.reduce((sum, link) => sum + (link.responseTime || 0), 0) / links.length)
                    : 0;
                  return (
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
                              Explanations
                            </summary>
                            <ul className="mt-2 bg-white border border-gray-200 rounded p-2 text-xs text-gray-700 max-w-xs">
                              {errors.map((err, idx) => (
                                <li key={idx} className="mb-1">
                                  <span className="font-bold">{err.code}</span>: {err.text} <br />
                                  <span className="text-gray-500">{err.url}</span>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-red-700">{count5xx}</span>
                        <span className="text-gray-700">/ {totalLinks} are <span className="font-bold">5xx Errors</span></span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-gray-700">{countOther}</span>
                        <span className="text-gray-700">other status</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-green-700">{(cacheHit / (cacheHit + cacheMiss) * 100).toFixed(2) || 0}%</span>
                        <span className="text-gray-700">Cache Hit Rate</span>
                        {/* <span className="font-bold text-gray-700">{cacheMiss}</span>
                        <span className="text-gray-700">cache misses</span> */}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-blue-700">{avgResponseTime}ms</span>
                        <span className="text-gray-700">avg response time</span>
                      </div>
                    </>
                  );
                })()}
              </div>

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
                                        <dt className="font-semibold text-gray-700">{key}:</dt>
                                        <dd className="text-gray-600 break-words text-xs ml-2">{value}</dd>
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
