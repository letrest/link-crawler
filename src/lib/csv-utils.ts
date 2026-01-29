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
}

export function generateCSV(links: LinkData[]): string {
  const headers = ['URL', 'Status', 'Status Text', 'Hit', 'All Headers', 'Error'];
  
  const rows = links.map((link) => {
    const allHeaders = link.headers
      ? Object.entries(link.headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join('; ')
      : '';
    return [
      `"${link.url.replace(/"/g, '""')}"`,
      link.status,
      `"${link.statusText.replace(/"/g, '""')}"`,
      `"${link.hit === true ? 'HIT' : 'MISS' }"`,
      `"${allHeaders.replace(/"/g, '""')}"`,
    //   `"${allHeaders["ncontent-legth"] || ''}"`,
    //   `"${allHeaders['lastModified'] || ''}"`,
      
      `"${(link.error || '').replace(/"/g, '""')}"`,
    ];
  });

  const csvContent = [
    headers.join(','),
    ...rows.map((row) => row.join(',')),
  ].join('\n');

  return csvContent;
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
