// Classic (non-module) script: browsers refuse to load ES modules from file:// pages, so app.js
// never runs there. This reveals a static explanation instead of leaving a dead page.
if (location.protocol === 'file:') document.getElementById('fileNotice').hidden = false;
