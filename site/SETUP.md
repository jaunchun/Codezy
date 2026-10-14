# Make CODEZY discoverable in Google

These starter files are for `https://codezy.kajtgorski.workers.dev/`.

## 1. Put the crawler files at the website root

Copy `robots.txt` and `sitemap.xml` into the directory your deployment serves as the site root. After deploying, both URLs should open directly:

- `https://codezy.kajtgorski.workers.dev/robots.txt`
- `https://codezy.kajtgorski.workers.dev/sitemap.xml`

If your Worker builds responses in code instead of serving static files, add routes that return these exact contents at those paths.

## 2. Add the page metadata

Add the contents of `page-head-snippet.html` inside the homepage's `<head>`. Edit the title and description if any wording does not match what the live product currently does. Keep only one title, description, and canonical tag on the page.

## 3. Register the site in Google Search Console

1. Open [Google Search Console](https://search.google.com/search-console/).
2. Add a **URL-prefix** property: `https://codezy.kajtgorski.workers.dev/`.
3. Verify ownership using the HTML-tag method. In Search Console, choose **HTML tag** and copy the complete `<meta name="google-site-verification" ...>` tag it provides into the homepage `<head>`, then deploy and click **Verify**. If Search Console already says the property is verified, skip this step.

The value `google-site-verification=a9LAsd_NCOq9jctpI9Eh_x6vAjascNSTFOS7VhdrPPM` you supplied is formatted as a DNS TXT record. Use it only in DNS if Search Console identifies DNS as your verification method. A `workers.dev` hostname is managed by Cloudflare, so you may not control DNS records for it; the HTML-tag method on a URL-prefix property is likely the practical option.

## 4. Submit the sitemap and request indexing

1. In Search Console, open **Sitemaps** and submit `https://codezy.kajtgorski.workers.dev/sitemap.xml`.
2. Open **URL Inspection**, enter `https://codezy.kajtgorski.workers.dev/`, run **Test live URL**, then select **Request indexing** if the test passes.
3. Check Search Console later for indexing status. Google may take time, and a request does not guarantee inclusion in search results.

## Notes

- The sitemap currently lists only the homepage. Add every public page you want indexed as another `<url><loc>FULL_URL</loc></url>` entry.
- `robots.txt` is for crawler guidance, not access control. Keep private pages protected by authentication.
- The files do not automatically change the deployed site; they must be copied into the site's source and deployed.
