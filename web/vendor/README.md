# Vendored browser libraries (served by the master on the gig LAN, no internet needed)

| file | what | version | licence |
|---|---|---|---|
| butterchurn.min.js | Milkdrop 2 in WebGL — jberg/butterchurn | 2.6.7 | MIT |
| butterchurnPresetsMD1.min.js | original Milkdrop 1 presets (87) | 2.4.7 | MIT / preset authors |
| butterchurnPresets.min.js | Butterchurn base pack (100) | 2.4.7 | MIT / preset authors |
| butterchurnPresetsExtra.min.js | Butterchurn extra pack (146) | 2.4.7 | MIT / preset authors |

Used ONLY for the in-browser projectM simulation (scene 8 preview). The Pis run libprojectM,
not Butterchurn — the browser shows the same-named preset where the packs overlap, otherwise
the closest name it can find, clearly labelled. Loaded lazily the first time scene 8 is selected.
