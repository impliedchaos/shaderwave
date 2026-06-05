// @ts-nocheck
// Built-in instrument presets, keyed by engine type. Each entry sets the synth
// param banks (p0/p1, plus p2/p3 for the Moog's osc/glide/noise) and optionally
// a recommended effects snapshot (`fx`). The sidebar preset dropdown loads these
// via Controls.loadPreset; preset matching compares p0/p1 only. (DX7 patches are
// not here — they come from the SysEx ROM banks parsed at runtime.)
export const PRESETS = {
  '303': [
    { name: 'Classic Acid Bassline', p0: [400, 0.72, 0.6, 0.4], p1: [0, 0.3, 0.4, 0], fx: { dist: 0.001, tone: 0.5, level: 1.0, width: 1.0, master: 0.32, chorusMix: 0.0, delayMix: 0.0, reverbMix: 0.0 } },
    { name: 'Aggressive Industrial Distortion', p0: [1200, 0.85, 0.8, 0.5], p1: [1, 0.2, 0.35, 0], fx: { dist: 12.0, tone: 0.65, level: 1.0, width: 1.2, master: 0.9, chorusMix: 0.35, chorusRate: 2.0, chorusDepth: 3.0, tremoloMix: 0.2, tremoloRate: 4.0, delayTime: 0.375, delayFeedback: 0.45, delayMix: 0.3, reverbDecay: 0.8, reverbDamp: 0.3, reverbSend: 0.5, reverbMix: 0.2 } },
    { name: 'Deep Cinematic Sweep', p0: [350, 0.9, 0.85, 0.3], p1: [0, 0.9, 0.8, 0], fx: { dist: 6.0, tone: 0.45, level: 1.0, width: 1.3, master: 0.8, chorusMix: 0.3, chorusRate: 1.2, chorusDepth: 2.5, delayTime: 0.6, delayFeedback: 0.5, delayMix: 0.35, reverbDecay: 0.85, reverbDamp: 0.3, reverbSend: 0.6, reverbMix: 0.3 } },
    { name: 'Retro Resonant Trance', p0: [800, 0.95, 0.85, 0.6], p1: [1, 0.3, 0.4, 0], fx: { dist: 8.0, tone: 0.5, level: 1.0, delayFeedback: 0.6, delayMix: 0.4 } },
    { name: 'Cyber Resonance', p0: [1500, 0.7, 0.8, 0.5], p1: [0, 0.2, 0.3, 0], fx: { dist: 15.0, tone: 0.6, level: 1.0, width: 1.4, delayMix: 0.25 } },
    { name: 'Glitchy Resonator', p0: [600, 0.8, 0.9, 0.4], p1: [0, 0.1, 0.2, 0], fx: { chorusMix: 0.4, delayMix: 0.3 } },
    { name: 'Darkwave Metallic', p0: [600, 0.8, 0.7, 0.4], p1: [1, 0.25, 0.3, 0], fx: { dist: 7.0, tone: 0.55, level: 1.0, delayMix: 0.2 } },
    { name: 'Hypnotic Minimalist Sub', p0: [120, 0.95, 0.8, 0.2], p1: [0, 0.1, 0.1, 0], fx: { dist: 3.0, tone: 0.4, level: 1.0, delayMix: 0.15 } },
    { name: 'Chiptune Resonant Square', p0: [2000, 0.2, 0.5, 0], p1: [1, 0.05, 0.05, 0], fx: { dist: 0.001, tone: 0.5, level: 1.0, delayTime: 0.2, delayFeedback: 0.4, delayMix: 0.3 } },
    { name: 'ProlapseBass', p0: [300, 0.8, 0.7, 0.5], p1: [1, 0.3, 0.4, 0] },
    { name: 'WetGooner', p0: [200, 0.9, 0.8, 0.6], p1: [0, 0.2, 0.35, 0] },
    { name: 'AcidNut', p0: [1200, 0.85, 0.6, 0.4], p1: [1, 0.4, 0.4, 0] },
    { name: 'GoonerScream', p0: [1500, 0.9, 0.5, 0.3], p1: [0, 0.3, 0.3, 0] },
    { name: 'PerkyPluck', p0: [600, 0.5, 0.7, 0.3], p1: [1, 0.15, 0.25, 0] },
    { name: 'WombatSqueeze', p0: [800, 0.6, 0.6, 0.4], p1: [1, 0.2, 0.3, 0] },
    { name: 'SuicideSweep', p0: [1800, 0.25, 0.3, 0.15], p1: [1, 0.1, 0.6, 0] },
    { name: 'Antiseptik', p0: [650, 0.45, 0.5, 0.2], p1: [1, 0.35, 0.45, 0] },
    { name: 'BouncyNut', p0: [800, 0.6, 0.4, 0.3], p1: [1, 0.2, 0.3, 0] },
    { name: 'MurderChug', p0: [400, 0.85, 0.3, 0.45], p1: [1, 0.1, 0.25, 0] },
    { name: 'LipstickLube', p0: [900, 0.4, 0.45, 0.25], p1: [1, 0.15, 0.25, 0] },
    { name: 'GymnopedieLead', p0: [600, 0.1, 0.4, 0.2], p1: [2.0, 0.3, 0.4, 0] },
    { name: 'Voltage Control Osc', p0: [1800, 0.96, 0.85, 0.6], p1: [1.0, 0.15, 0.25, 0] }
  ],
  '808': [
    { name: 'Classic 808 Kit', p0: [0, 0.6, 0.5, 0.6], p1: [0, 0, 0, 0], fx: { dist: 0.001, tone: 0.5, level: 1.0, width: 1.0, master: 0.32 } },
    { name: 'Industrial Saturation Kit', p0: [0, 0.4, 0.7, 0.8], p1: [0, 0, 0, 0], fx: { dist: 14.0, tone: 0.5, level: 1.0, width: 0.8, master: 1.0, delayTime: 0.25, delayFeedback: 0.3, delayMix: 0.15, reverbDecay: 0.6, reverbDamp: 0.5, reverbSend: 0.4, reverbMix: 0.15 } },
    { name: 'Cinematic Spatial Kit', p0: [0, 0.5, 0.8, 0.4], p1: [0, 0, 0, 0], fx: { dist: 2.0, tone: 0.55, level: 1.0, width: 0.9, master: 1.0, delayTime: 0.3, delayFeedback: 0.2, delayMix: 0.1, reverbDecay: 0.9, reverbDamp: 0.4, reverbSend: 0.7, reverbMix: 0.6 } },
    { name: 'GoonerBoom', p0: [0, 0.5, 0.8, 0.8], p1: [0, 0, 0, 0] },
    { name: 'PerkyTitsKit', p0: [0, 0.6, 0.5, 0.6], p1: [0, 0, 0, 0] },
    { name: 'CuckGatedKit', p0: [0, 0.5, 0.8, 0.6], p1: [0, 0, 0, 0] },
    { name: 'AntisepticKit', p0: [0, 0.5, 0.45, 0.6], p1: [0, 0, 0, 0] },
    { name: 'LeftNutKit', p0: [0, 0.55, 0.4, 0.5], p1: [0, 0, 0, 0] },
    { name: 'MurderPartyKit', p0: [0, 0.6, 0.8, 0.4], p1: [0, 0, 0, 0] },
    { name: 'LatchkeyKit', p0: [0, 0.5, 0.45, 0.5], p1: [0, 0, 0, 0] },
    { name: 'VinylKit', p0: [0, 0.45, 0.5, 0.5], p1: [0, 0, 0, 0] },
    { name: 'Booty Metal Kit', p0: [0, 0.6, 0.5, 0.6], p1: [0, 0, 0, 0] }
  ],
  'moog': [
    { name: 'Classic Poly Pluck', p0: [800, 0.45, 0.5, 0], p1: [8, 0.8, 0.6, 0.9], p2: [1, 1, 1, 0], p3: [2, 2, 2, 0], fx: { dist: 0.001, tone: 0.5, level: 1.0, width: 1.0, master: 0.32 } },
    { name: 'Industrial Laser Lead', p0: [600, 0.6, 0.7, 0], p1: [25, 0.4, 1.2, 0.8], fx: { dist: 7.0, tone: 0.65, level: 1.0, width: 1.4, master: 0.7, chorusMix: 0.6, chorusRate: 0.8, chorusDepth: 5.0, tremoloMix: 0.3, tremoloRate: 2.5, delayTime: 0.5, delayFeedback: 0.5, delayMix: 0.3, reverbDecay: 0.95, reverbDamp: 0.2, reverbSend: 0.9, reverbMix: 0.6 } },
    { name: 'Cinematic Ambient Pad', p0: [400, 0.6, 0.5, 0], p1: [15, 0.8, 1.2, 0.9], fx: { dist: 3.0, tone: 0.45, level: 1.0, width: 1.2, master: 0.9, chorusMix: 0.4, chorusRate: 0.5, chorusDepth: 3.0, delayTime: 0.5, delayFeedback: 0.3, delayMix: 0.15, reverbDecay: 0.95, reverbDamp: 0.2, reverbSend: 0.9, reverbMix: 0.5 } },
    { name: 'Muffled Noir Bass', p0: [400, 0.45, 0.5, 0], p1: [8, 0.8, 0.6, 0.9], fx: { reverbMix: 0.4, reverbDecay: 0.9 } },
    { name: 'Cyberpunk Ladder Bass', p0: [800, 0.5, 0.6, 0], p1: [20, 0.8, 0.6, 0.9], fx: { dist: 7.0, tone: 0.5, level: 1.0, chorusMix: 0.4 } },
    { name: 'Punchy Retro Synthwave', p0: [1200, 0.4, 0.5, 0], p1: [5, 0.8, 0.1, 0.2], fx: { dist: 2.5, tone: 0.5, level: 1.0 } },
    { name: 'Deep Space Drone', p0: [300, 0.3, 0.4, 0], p1: [30, 0.9, 1.8, 1.8], fx: { reverbDecay: 0.97, reverbMix: 0.6 } },
    { name: 'Liquid Drum & Bass Sub', p0: [150, 0.0, 0.0, 0], p1: [0, 0.9, 0.8, 0.8], fx: { dist: 0.001, tone: 0.5, level: 1.0 } },
    { name: 'MoogProlapse', p0: [150, 0.7, 0.8, 0], p1: [4, 0.9, 0.5, 0.8], p2: [2, 1, 1, 0], p3: [2, 2, 1, 0] },
    { name: 'MoogGooner', p0: [120, 0.8, 0.9, 0], p1: [6, 0.95, 0.6, 0.9], p2: [2, 2, 1, 0], p3: [2, 2, 2, 0] },
    { name: 'GoonerGlide', p0: [900, 0.3, 0.4, 0.35], p1: [12, 0.5, 0.7, 0.4], p2: [1, 2, 1, 0.05], p3: [2, 2, 3, 0] },
    { name: 'MoogScreamer', p0: [1400, 0.2, 0.3, 0.4], p1: [16, 0.4, 0.8, 0.3], p2: [1, 3, 2, 0.04], p3: [2, 3, 2, 0] },
    { name: 'PerkyLead', p0: [1200, 0.4, 0.5, 0.35], p1: [8, 0.8, 0.6, 0.9], p2: [1, 1, 2, 0.05], p3: [2, 2, 3, 0] },
    { name: 'BreathAwayPad', p0: [400, 0.2, 0.3, 0.1], p1: [15, 0.8, 1.5, 1.2], p2: [1, 1, 0, 0], p3: [2, 2, 1, 0.05] },
    { name: 'CuckSoaring', p0: [900, 0.4, 0.6, 0.45], p1: [6, 0.9, 0.8, 0.6], p2: [1, 1, 2, 0.08], p3: [2, 3, 2, 0] },
    { name: 'SuicideWarm', p0: [180, 0.15, 0.7, 0], p1: [2, 0.95, 0.8, 1.2], p2: [2, 1, 1, 0], p3: [2, 2, 1, 0] },
    { name: 'EtherealSuicide', p0: [120, 0.08, 0.85, 0.1], p1: [1, 0.98, 1.2, 1.5], p2: [1, 1, 0, 0], p3: [2, 2, 2, 0.04] },
    { name: 'AntiseptikSoar', p0: [900, 0.35, 0.45, 0.45], p1: [15, 0.6, 0.8, 0.6], p2: [1, 1, 2, 0.07], p3: [2, 3, 2, 0] },
    { name: 'NutFunkBass', p0: [300, 0.25, 0.6, 0], p1: [4, 0.9, 0.65, 0.9], p2: [2, 1, 1, 0.02], p3: [2, 2, 1, 0] },
    { name: 'BritpopLead', p0: [1200, 0.4, 0.5, 0.4], p1: [12, 0.55, 0.75, 0.5], p2: [1, 2, 2, 0.05], p3: [2, 2, 3, 0] },
    { name: 'MurderGrowl', p0: [180, 0.15, 0.8, 0], p1: [2, 0.95, 0.8, 1.2], p2: [2, 2, 1, 0], p3: [2, 2, 1, 0.04] },
    { name: 'ZeppelinLead', p0: [950, 0.3, 0.5, 0.45], p1: [15, 0.7, 0.75, 0.5], p2: [1, 1, 2, 0.06], p3: [2, 3, 2, 0] },
    { name: 'LatchkeyBass', p0: [150, 0.05, 0.8, 0], p1: [1, 0.98, 0.8, 1], p2: [0, 0, 1, 0], p3: [2, 1, 2, 0] },
    { name: 'TailpipePulse', p0: [1000, 0.25, 0.45, 0.4], p1: [12, 0.6, 0.75, 0.5], p2: [3, 4, 3, 0.05], p3: [2, 2, 3, 0] },
    { name: 'SubGymnopedie', p0: [150, 0.2, 0.5, 0], p1: [2.0, 0.9, 0.8, 0.8], p2: [2, 1, 1, 0], p3: [2, 2, 1, 0] },
    { name: 'Axe Bass', p0: [600, 0.6, 0.7, 0.2], p1: [12.0, 0.8, 0.6, 0.8], p2: [2, 1, 2, 0.02], p3: [2, 2, 2, 0] }
  ]
};
