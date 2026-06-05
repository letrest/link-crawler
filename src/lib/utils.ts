export interface SecurityHeader {
  name: string;
  headerName: string;
  importance: 'critical' | 'high' | 'medium' | 'low';
  purpose: string;
  protectsAgainst: string[];
  recommendedValue: string;
  present: boolean;
}

export interface SecurityReport {
  headers: SecurityHeader[];
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  present: number;
  total: number;
  missing: SecurityHeader[];
}

export type SecurityHeaderConfig = Omit<SecurityHeader, 'present'>;

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
  securityReport?: SecurityReport;
  originPage?: string;
  selector?: string;
  linkText?: string;
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
    } else if (link.status >= 500 && link.status < 600) {
      count5xx++;
      errors.push({ code: link.status, text: link.statusText, url: link.url });
    } else countOther++;

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

export interface SecurityHeader {
  name: string;
  headerName: string;
  importance: 'critical' | 'high' | 'medium' | 'low';
  purpose: string;
  protectsAgainst: string[];
  recommendedValue: string;
  present: boolean;
}

export interface SecurityReport {
  headers: SecurityHeader[];
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  present: number;
  total: number;
  missing: SecurityHeader[];
}

export const SECURITY_HEADERS_CONFIG: SecurityHeaderConfig[] = [
  {
    name: 'Strict-Transport-Security',
    headerName: 'Strict-Transport-Security',
    importance: 'critical',
    purpose: 'Forces the browser to interact with the website exclusively over HTTPS, preventing SSL-stripping and protocol-downgrade attacks.',
    protectsAgainst: ['SSL-stripping', 'Protocol-downgrade attacks', 'Man-in-the-middle attacks'],
    recommendedValue: 'max-age=31536000; includeSubDomains; preload',
  },
  {
    name: 'Content-Security-Policy',
    headerName: 'Content-Security-Policy',
    importance: 'critical',
    purpose: 'Defines which resources (scripts, images, styles) are allowed to load and from where, blocking untrusted content.',
    protectsAgainst: ['Cross-Site Scripting (XSS)', 'Data injection attacks', 'Malicious script injection'],
    recommendedValue: "default-src 'self'; script-src 'self'",
  },
  {
    name: 'X-Content-Type-Options',
    headerName: 'X-Content-Type-Options',
    importance: 'high',
    purpose: 'Prevents the browser from guessing (MIME-sniffing) the type of a file.',
    protectsAgainst: ['MIME-sniffing attacks', 'File type disguise attacks'],
    recommendedValue: 'nosniff',
  },
  {
    name: 'X-Frame-Options',
    headerName: 'X-Frame-Options',
    importance: 'high',
    purpose: 'Indicates whether a page can be rendered in an iframe, frame, or object element.',
    protectsAgainst: ['Clickjacking attacks', 'UI redressing'],
    recommendedValue: 'DENY or SAMEORIGIN',
  },
  {
    name: 'Referrer-Policy',
    headerName: 'Referrer-Policy',
    importance: 'medium',
    purpose: 'Controls how much referrer information is sent when navigating away.',
    protectsAgainst: ['Information leakage', 'Session ID leakage in URLs'],
    recommendedValue: 'strict-origin-when-cross-origin',
  },
  {
    name: 'Permissions-Policy',
    headerName: 'Permissions-Policy',
    importance: 'medium',
    purpose: 'Explicitly enables or disables browser features and APIs like camera, microphone, and geolocation.',
    protectsAgainst: ['Unauthorized hardware access', 'Malicious feature abuse'],
    recommendedValue: 'camera=(), microphone=(), geolocation=()',
  },
  {
    name: 'Cross-Origin-Opener-Policy',
    headerName: 'Cross-Origin-Opener-Policy',
    importance: 'high',
    purpose: 'Decides if a new window should be opened in the same browsing context group or isolated.',
    protectsAgainst: ['Spectre-class side-channel attacks', 'Cross-origin scripting'],
    recommendedValue: 'same-origin-allow-popups',
  },
  {
    name: 'Cross-Origin-Embedder-Policy',
    headerName: 'Cross-Origin-Embedder-Policy',
    importance: 'medium',
    purpose: 'Prevents loading cross-origin resources that do not explicitly opt-in.',
    protectsAgainst: ['XS-Leaks', 'Unauthorized resource embedding'],
    recommendedValue: 'require-corp',
  },
  {
    name: 'Cross-Origin-Resource-Policy',
    headerName: 'Cross-Origin-Resource-Policy',
    importance: 'medium',
    purpose: 'Allows a resource to indicate it can only be loaded by same-origin or same-site documents.',
    protectsAgainst: ['Cross-origin data exfiltration', 'Spectre attacks'],
    recommendedValue: 'same-origin or same-site',
  },
];

export function analyzeSecurityHeaders(headers: Record<string, string>): SecurityReport {
  const headerNames = Object.keys(headers).map((h) => h.toLowerCase());
  
  const analyzed = SECURITY_HEADERS_CONFIG.map((config) => {
    const present = headerNames.some((h) => h === config.headerName.toLowerCase());
    return {
      ...config,
      present,
    };
  });

  const presentCount = analyzed.filter((h) => h.present).length;
  const totalCount = analyzed.length;
  const percent = (presentCount / totalCount) * 100;

  let grade: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' = 'F';
  if (percent >= 90) grade = 'A';
  else if (percent >= 80) grade = 'B';
  else if (percent >= 70) grade = 'C';
  else if (percent >= 60) grade = 'D';
  else if (percent >= 50) grade = 'E';

  return {
    headers: analyzed,
    score: Math.round(percent),
    grade,
    present: presentCount,
    total: totalCount,
    missing: analyzed.filter((h) => !h.present),
  };
}

export function computeAggregateSecurityReport(reports: SecurityReport[]): SecurityReport {
  if (reports.length === 0) {
    return {
      headers: SECURITY_HEADERS_CONFIG.map((config) => ({
        ...config,
        present: false,
      })),
      score: 0,
      grade: 'F',
      present: 0,
      total: SECURITY_HEADERS_CONFIG.length,
      missing: SECURITY_HEADERS_CONFIG.map((config) => ({
        ...config,
        present: false,
      })),
    };
  }

  const reportCount = reports.length;
  const aggregated = SECURITY_HEADERS_CONFIG.map((config) => {
    const presentCount = reports.reduce((count, report) => {
      const found = report.headers.find((header) => header.headerName.toLowerCase() === config.headerName.toLowerCase());
      return count + (found?.present ? 1 : 0);
    }, 0);

    const present = presentCount === reportCount;
    return {
      ...config,
      present,
    };
  });

  const presentCount = aggregated.filter((h) => h.present).length;
  const percent = (presentCount / aggregated.length) * 100;
  let grade: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' = 'F';
  if (percent >= 90) grade = 'A';
  else if (percent >= 80) grade = 'B';
  else if (percent >= 70) grade = 'C';
  else if (percent >= 60) grade = 'D';
  else if (percent >= 50) grade = 'E';

  return {
    headers: aggregated,
    score: Math.round(percent),
    grade,
    present: presentCount,
    total: aggregated.length,
    missing: aggregated.filter((h) => !h.present),
  };
}
