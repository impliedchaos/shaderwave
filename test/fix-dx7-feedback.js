const fs = require('fs');
const path = require('path');

const filePath = '/home/dave/code/synth/src/gl/shaders/synth-dx7.js';
let content = fs.readFileSync(filePath, 'utf8');

// 1. Replace the feedback variable declarations
content = content.replace(
  '  float f6 = fbVal * oscSine(ph6) * lvl6;\n' +
  '  float f5 = fbVal * oscSine(ph5) * lvl5;\n' +
  '  float f4 = fbVal * oscSine(ph4) * lvl4;\n' +
  '  float f3 = fbVal * oscSine(ph3) * lvl3;\n' +
  '  float f2 = fbVal * oscSine(ph2) * lvl2;',
  '  float fb6 = fbVal * oscSine(ph6) * lvl6;\n' +
  '  float fb5 = fbVal * oscSine(ph5) * lvl5;\n' +
  '  float fb4 = fbVal * oscSine(ph4) * lvl4;\n' +
  '  float fb3 = fbVal * oscSine(ph3) * lvl3;\n' +
  '  float fb2 = fbVal * oscSine(ph2) * lvl2;'
);

// 2. Replace uses of f2..f6 in the algorithms.
// Since all of them appear after the declarations, we can split the file,
// apply replacements in the second part, and join them back.
const splitStr = '// Self-feedback modulation (for algorithms containing feedback operators)';
const parts = content.split(splitStr);

if (parts.length === 2) {
  let algoSection = parts[1];
  // Replace + f2, + f3, + f4, + f5, + f6 (with word boundary or trailing characters)
  algoSection = algoSection.replace(/\+ f6\b/g, '+ fb6');
  algoSection = algoSection.replace(/\+ f5\b/g, '+ fb5');
  algoSection = algoSection.replace(/\+ f4\b/g, '+ fb4');
  algoSection = algoSection.replace(/\+ f3\b/g, '+ fb3');
  algoSection = algoSection.replace(/\+ f2\b/g, '+ fb2');

  content = parts[0] + splitStr + algoSection;
  fs.writeFileSync(filePath, content, 'utf8');
  console.log("Renamed feedback variables successfully!");
} else {
  console.error("Error: Could not split file correctly.");
}
