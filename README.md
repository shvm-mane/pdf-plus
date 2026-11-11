<h1 align="center">PDF+ (browser extension)</h1>

<p align="center">
  acrobat/PDF.js if it wasnt ass and just did the one thing its supposed to do
</p>

<p align="center">
  <a href="https://github.com/shvm-mane/pdf-plus/releases/latest"><b>DOWNLOAD</b></a>
</p>

<p align="center"><img src="screenshot.png" alt="PDF+"></p>

## what it does

- opens every pdf (web + local) in a fast, minimal viewer
- chromium-style text selection
- smooth pinch zoom, fit width / page, rotate
- resizable pages & outline sidebar
- vim keys: `j` `k` scroll, `gg` `G`, `:` go to page
- download, print, one-click [ihatepdf](https://www.ihatepdf.cv/)
- stays snappy on 1000+ page pdfs

## install

**chromium** (128+)
1. download `pdf-plus-chromium.zip` from [releases](https://github.com/shvm-mane/pdf-plus/releases/latest) and unzip it
2. go to `chrome://extensions`, turn on **developer mode**
3. **load unpacked** → pick the unzipped folder
4. open PDF+ **details** → turn on **allow access to file URLs** (for local pdfs) and set **site access** to **on all sites**

## credits

- **[pdf.js](https://github.com/mozilla/pdf.js)** by mozilla (apache 2.0, see `pdfjs/LICENSE`): pdf rendering
- **[chromium](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/pdf/)** pdf viewer (bsd-3-clause): text selection behaviour, ported to js

## license

[MIT](LICENSE) (includes pdf.js's and chromium's notices)
