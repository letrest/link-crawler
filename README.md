This is a NextJS app that takes a URL, crawls the page and fetches the same domain links on the page. It's intended to give you a high-level idea of the site including the erorr rate, the cacheability of the site among other things. 

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser.
Type in the page you want to crawl and choose whether or not you want to capture the body of each response (which you can preview as well). 
Then click Start Crawl.
You can stop the crawl at any time by clicking the stop button and it will show you the results so far or you can wait for it to finish all of the links on the page.
You can then download the CSV of the response headers (this file contains **only** the per-link rows). If you need the summary stats there is a separate "Download Summary" button that emits a smaller CSV with only the aggregated totals and errors.

## Features Added
* Get a 429, wait a bit? done with an exponential backoff wtih gradual recovery:
* * First 429, check "Retry After" header and respect it if it exists.
* * If no "Retry After" header, wait 5s and slow rate by adding 1s delay between GETs. Gradually recover speed by 10% after every 5 successful (non 429s)
* * If no retry after and hit by another 429, increase the inital wait and the delay between GETs by 2x
* * rinse, repeat
* Manual Throttling slider [0-5s] by multiples of 10ms.
* Adding a final crawl report that shows tital time spent and rate limit events

## TO DO
* Add query parameter caching test
* Add the ability to wait for render in case links get pulled client-side?
* Add CRUX / pagespeed insights API for CWV?
* Add the ability to add request headers / and or cookies to get around being blocked
* Add security header checks




