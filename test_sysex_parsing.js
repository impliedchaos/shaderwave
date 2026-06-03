const fs = require('fs');

const data = fs.readFileSync('/home/dave/code/synth/sysex/DX7/solidlatelybass.syx');

// 32 voices, find LatelyBass and SolidBass
for (let i = 0; i < 32; i++) {
  const offset = 6 + i * 128;
  const voiceData = data.subarray(offset, offset + 128);
  
  let name = "";
  for (let c = 0; c < 10; c++) {
    name += String.fromCharCode(voiceData[118 + c]);
  }
  name = name.trim();
  
  if (name.toLowerCase().includes('lately') || name.toLowerCase().includes('solid')) {
    console.log(`\nPatch ${i+1}: "${name}"`);
    for (let k = 0; k < 6; k++) {
      const opOffset = (5 - k) * 17;
      const b15 = voiceData[opOffset + 15];
      
      // Current parsing in controls.js:
      const curMode = b15 & 1;
      const curCoarse = (b15 >> 1) & 31;
      
      // Standard DX7 format (Bit 1 = mode, Bits 2-6 = coarse):
      const stdMode = (b15 >> 1) & 1;
      const stdCoarse = (b15 >> 2) & 31;
      
      console.log(`  Op ${k+1}: Raw=${b15} (hex: ${b15.toString(16)}, bin: ${b15.toString(2).padStart(8, '0')})`);
      console.log(`    Current -> Mode: ${curMode}, Coarse: ${curCoarse}`);
      console.log(`    Standard -> Mode: ${stdMode}, Coarse: ${stdCoarse}`);
    }
  }
}
