const puppeteer = require('puppeteer');
(async () => {
  const [,, input, output, w, h] = process.argv;
  const b = await puppeteer.launch({ headless: 'new' });
  const p = await b.newPage();
  await p.setViewport({ width: +w, height: +h, deviceScaleFactor: 1 });
  await p.goto('file://' + input);
  await p.screenshot({ path: output, clip: { x: 0, y: 0, width: +w, height: +h } });
  await b.close();
})();
