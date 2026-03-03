export interface LinkData {
  url: string;
  status: number;
  statusText: string;
  lastModified?: string;
  contentLength?: string;
  hit?: boolean;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  responseTime?: number;
}
export const cacheHitConditions = (data: LinkData) => [
  data.headers?.['Age'] && parseInt(data.headers?.['Age']) > 0,
  data.headers?.['age'] && parseInt(data.headers?.['age']) > 0,
  data.headers?.['x-cache'] && data.headers?.['x-cache'].includes('HIT'),
  data.headers?.['X-Cache'] && data.headers?.['X-Cache'].includes('HIT'),
  data.headers?.['x-harperdb-cache'] && data.headers?.['x-harperdb-cache'].includes("HIT"),
  data.headers?.['server-timing'] && data.headers?.['server-timing'].includes('cdn-cache; desc=HIT'),
  data.headers?.['akamai-cache-status'] && data.headers?.['akamai-cache-status'].includes('Hit'),
  data.headers?.['x-nextjs-cache'] && data.headers?.['x-nextjs-cache'].includes('HIT'),
  data.headers?.['cf-cache-status'] && data.headers?.['cf-cache-status'].includes('HIT'),
];

/**
 * Compute summary statistics from an array of link data.
 *
 * This mirrors the logic previously contained inside `page.tsx` and is
 * shared by both `generateCSV` and the new `generateSummaryCSV` helper.
 */
export function computeSummaryStats(links: LinkData[], totalLinks?: number) {
  let count200 = 0,
    count4xx = 0,
    count5xx = 0,
    countOther = 0;
  let cacheHit = 0,
    cacheMiss = 0;
  const errors: { code: number; text: string; url: string }[] = [];

  links.forEach((link) => {
    if (link.status === 200) count200++;
    else if (link.status >= 400 && link.status < 500) {
      count4xx++;
      errors.push({ code: link.status, text: link.statusText, url: link.url });
    } else if (link.status >= 500 && link.status < 600) count5xx++;
    else countOther++;

    if (link.hit) cacheHit++;
    else cacheMiss++;
  });

  return {
    count200,
    count4xx,
    count5xx,
    countOther,
    cacheHit,
    cacheMiss,
    errors,
    total: totalLinks ?? links.length,
  };
}

export function generateSummaryCSV(links: LinkData[], totalLinks?: number) {
  const {
    count200,
    count4xx,
    count5xx,
    countOther,
    cacheHit,
    cacheMiss,
    errors,
    total,
  } = computeSummaryStats(links, totalLinks);

  const rows: string[][] = [
    [`200 OK`, `${count200} / ${total}`],
    [`4xx Errors`, `${count4xx} / ${total}`],
    [`5xx Errors`, `${count5xx} / ${total}`],
    [`Other Status`, `${countOther}`],
    [`Cache Hits`, `${cacheHit}`],
    [`Cache Misses`, `${cacheMiss}`],
  ];

  if (errors.length > 0) {
    rows.push(['4xx Error Details', '']);
    errors.forEach((err) => {
      rows.push([`${err.code}: ${err.text}`, err.url]);
    });
  }

  return rows.map((r) => r.map((v) => `"${v}"`).join(',')).join('\n');
}

export function generateCSV(links: LinkData[], totalLinks?: number) {
  // produce CSV only for the individual link entries; summary is omitted
  const header = [
    'URL',
    'Status',
    'StatusText',
    'ContentLength',
    'ResponseTime (ms)',
    'CacheHit',
    'Error',
    'Headers',
    'Body',
  ];
  const rows = links.map((link) => [
    link.url,
    link.status,
    link.statusText,
    link.contentLength ?? '',
    link.responseTime ?? '',
    link.hit ? 'HIT' : 'MISS',
    link.error ?? '',
    JSON.stringify(link.headers ?? {}),
    link.body ? link.body.slice(0, 1000) : '',
  ]);

  // CSV string
  const csv = [
    header.map((h) => `"${h}"`).join(','),
    ...rows.map((r) => r.map((v) => `"${v}"`).join(',')),
  ].join('\n');

  return csv;
}

export function downloadCSV(csvContent: string, filename: string = 'link-report.csv') {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
