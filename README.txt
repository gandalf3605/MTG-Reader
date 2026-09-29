Spoken Card Reader - version 1

What it is: a web app for Android that reads the game information of a Magic: The Gathering card
aloud when you point the phone camera at it.

TO PUBLISH ON GITHUB PAGES
1. On github.com create a new PUBLIC repository (any name, e.g. card-reader).
2. Click "uploading an existing file". Drag in EVERYTHING from this folder (index.html, sw.js,
   manifest.webmanifest, and the folders css, js, icons, vendor). Click "Commit changes".
   (GitHub's web page takes up to 100 files at once; this folder has about 19.)
3. Repository Settings > Pages > Build and deployment > Source: "Deploy from a branch",
   Branch: main, Folder: / (root) > Save. Wait 1-2 minutes.
4. Your app is at https://YOUR-USERNAME.github.io/REPOSITORY-NAME/

ON THE ANDROID PHONE (Chrome)
1. Open the address above. Tap Allow when Chrome asks for the camera.
2. Wait for "Scanning" (first launch downloads about 15 MB, then it is cached).
3. Menu (three dots) > "Add to Home screen" / "Install app" so it opens like an app.
4. Tap the screen once when asked, to turn on voice.

TROUBLESHOOTING
Open the address with ?debug=1 on the end to see what the reader is seeing.
