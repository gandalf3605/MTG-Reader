Spoken Card Reader - version 4

WHAT CHANGED IN V4
- The reader no longer reads live video constantly. It now works in stages:
  see a card outline > wait until the card is steady > keep the sharpest frame > clean it up >
  read the name several ways and check the artwork > read the card aloud > STOP.
- After a card is read, scanning stops. Tap anywhere on the camera view, or the big yellow
  "Scan next card" button, to clear it and look for the next card. "Repeat" says the card again.
- A vibration tick means the picture was taken: hold still until the voice starts.

WHAT CHANGED IN V3

WHAT CHANGED IN V3
- Card finding now evens out uneven light and shadows first, and uses adaptive edge detection, so it copes
  with dim rooms, glare, sleeves and full-art cards much better.
- If the outline is unclear it tries other candidate outlines (including other cards in view).
- The name bar is read two ways (smooth grey and hard black-and-white) and the results are combined.
- Very short card names now need a closer match before they are announced (fewer wrong guesses).
- New file: js/recognize.js (upload it along with the rest).

WHAT CHANGED IN V2
- Finds the card in the camera picture, straightens it, and reads only the name bar (much faster).
- Cross-checks the card artwork against a public fingerprint list to confirm or rescue a shaky name read.
- Falls back to the old whole-picture reading if the card outline can't be found.

TO UPDATE AN EXISTING GITHUB PAGES SITE
1. Open your repository on github.com > Add file > Upload files.
2. Drag in EVERYTHING from this folder (index.html, sw.js, manifest.webmanifest, and the folders
   css, js, icons, vendor). GitHub replaces files with the same name. Commit changes.
   (The web page accepts up to 100 files at once; this folder has about 22.)
3. Wait 1-2 minutes. On the phone open the page, then fully close and reopen it TWICE
   (the first reopen installs the new version, the second uses it).

FIRST-TIME SETUP
1. Create a new PUBLIC repository, upload everything as above.
2. Settings > Pages > Source: "Deploy from a branch", Branch: main, Folder: / (root) > Save.
3. Your app is at https://YOUR-USERNAME.github.io/REPOSITORY-NAME/

ON THE ANDROID PHONE (Chrome)
1. Open the address. Tap Allow for the camera. First launch downloads about 35 MB, then it is cached.
2. Menu (three dots) > Add to Home screen / Install app.
3. Tap the screen once when asked, to turn on voice.

TROUBLESHOOTING
Add ?debug=1 to the end of the address to see what the reader sees: which method it used, how long each
step took, the text it read, and the art-check distance. A screenshot of that is the best bug report.
