import { createWorker } from 'tesseract.js';
(async () => {
  const worker = await createWorker('eng');
  const ret = await worker.recognize('https://tesseract.projectnaptha.com/img/eng_bw.png');
  console.log(Object.keys(ret.data));
  console.log(ret.data.blocks ? ret.data.blocks.length : 'no blocks');
  console.log(ret.data.words ? ret.data.words.length : 'no words');
  await worker.terminate();
})();
