require('dotenv').config();

const express = require('express');
const session = require('express-session');
const SpotifyWebApi = require('spotify-web-api-node');
const path = require('path');

const app = express();
const PORT = 8000;

/* -------------------------
   Environment
------------------------- */

const {
  CLIENT_ID,
  SECRET_CLIENT_ID,
  REDIRECT_URL,
  SESSION_SECRET
} = process.env;

if (!CLIENT_ID || !SECRET_CLIENT_ID || !REDIRECT_URL) {
  throw new Error('Missing Spotify credentials in .env');
}

const SCOPE = [
  'user-library-read',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
  'streaming'
].join(' ');

/* -------------------------
   Middleware
------------------------- */

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: SESSION_SECRET || 'SUPER_SECRET_KEY',
  resave: false,
  saveUninitialized: false
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

/* -------------------------
   Helpers
------------------------- */

function createSpotifyClient() {
  return new SpotifyWebApi({
    clientId: CLIENT_ID,
    clientSecret: SECRET_CLIENT_ID,
    redirectUri: REDIRECT_URL
  });
}

function getSpotifyFromSession(req) {
  if (!req.session.tokenInfo) return null;

  const sp = createSpotifyClient();
  sp.setAccessToken(req.session.tokenInfo.access_token);
  sp.setRefreshToken(req.session.tokenInfo.refresh_token);
  return sp;
}

async function getUserPlaylists(sp) {
  let playlists = [];
  let data = await sp.getUserPlaylists({ limit: 50 });

  playlists.push(...data.body.items);

  while (data.body.next) {
    data = await sp.getUserPlaylists({
      limit: 50,
      offset: playlists.length
    });
    playlists.push(...data.body.items);
  }
  return playlists;
}

async function getPlaylistTracks(sp, playlistId) {
  let tracks = [];
  let offset = 0;

  while (true) {
    const data = await sp.getPlaylistTracks(playlistId, {
      limit: 100,
      offset
    });

    for (const item of data.body.items) {
      if (!item.track || item.track.is_local) continue;
      tracks.push(item.track);
    }

    if (!data.body.next) break;
    offset += 100;
  }
  return tracks;
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}
function pickSongs(array, time, attempts = 10) {
  const time_in_ms = time * 60000;
  let bestCombination = [];
  let bestTime = 0;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let shuffledArray = [...array];
    shuffleArray(shuffledArray);

    let currentCombination = [];
    let currentTime = 0;

    for (let track of shuffledArray) {
      if (currentTime + track.duration_ms <= time_in_ms) {
        currentCombination.push(track);
        currentTime += track.duration_ms;
      }
    }

    // Keep the best combination so far
    if (currentTime > bestTime) {
      bestTime = currentTime;
      bestCombination = currentCombination;
    }
  }

  // Log total duration
  const minutes = Math.floor(bestTime / 60000);
  const seconds = Math.floor((bestTime % 60000) / 1000);
  console.log(`Total duration: ${minutes}m ${seconds}s`);

  return bestCombination;
}

// Fisher–Yates shuffle
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}


/* -------------------------
   Routes
------------------------- */
app.get('/timedqueue', async (req, res) => {
  const sp = getSpotifyFromSession(req);
  if (!sp) return res.redirect('/login');

  try {
    const playlists = await getUserPlaylists(sp);
    res.render('timed_selection', { playlists });
  } catch (err) {
    res.send('Error fetching playlists');
  }
})
app.post('/tq', async (req, res) => {
  const sp = getSpotifyFromSession(req);
  if (!sp) return res.redirect('/login');

  const playlistId = req.body.playlist_id;
  if (!playlistId) {
    return res.render('timed_queue', {
      message: 'No playlist selected.',
      playlist_name: null,
      playlist_image: null,
      tracks: []
    });
  }
  const queueDuration = req.body.duration_minutes;

  if (!queueDuration) {
    return res.render('timed_queue', {
      message: 'No playlist selected.',
      playlist_name: null,
      playlist_image: null,
      tracks: []
    });
  }
  try {
    var tracks = await getPlaylistTracks(sp, playlistId);
    if (!tracks.length) {
      return res.render('timed_queue', {
        message: 'No tracks found in this playlist.',
        playlist_name: null,
        playlist_image: null,
        tracks: []
      });
    }

    tracks = pickSongs(tracks, queueDuration)
    const uris = tracks.map(t => t.uri);

    await sp.play({ uris });

    const playlistData = await sp.getPlaylist(playlistId);

    res.render('timed_queue', {
      message: 'Shuffling and playback started!',
      playlist_name: playlistData.body.name,
      playlist_image: playlistData.body.images[0]?.url || null,
      tracks
    });

  } catch (err) {
    res.render('timed_selection', {
      message:
        'No active Spotify device found. Please open Spotify on one of your devices and try again.',
      playlist_name: null,
      playlist_image: null,
      tracks: []
    });
  }
});

app.get('/', (req, res) => {
  res.render('index')
});

app.get('/tools', (req, res) => {
  res.render('tools')
});
app.get('/login', (req, res) => {
  if (!req.session.tokenInfo) {
    const sp = createSpotifyClient();
    const authUrl = sp.createAuthorizeURL(SCOPE.split(' '));
    res.redirect(authUrl);
  } else {
    res.redirect('/tools')
  }

});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send('Authorization failed');

  const sp = createSpotifyClient();

  try {
    const data = await sp.authorizationCodeGrant(code);
    req.session.tokenInfo = data.body;
    res.redirect('/tools');
  } catch (err) {
    res.send(`Error getting access token: ${err.message}`);
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/choose', async (req, res) => {
  const sp = getSpotifyFromSession(req);
  if (!sp) return res.redirect('/login');

  try {
    const playlists = await getUserPlaylists(sp);
    res.render('choose_playlist', { playlists });
  } catch (err) {
    res.send('Error fetching playlists');
  }
});

app.post('/shuffle', async (req, res) => {
  const sp = getSpotifyFromSession(req);
  if (!sp) return res.redirect('/login');

  const playlistId = req.body.playlist_id;
  if (!playlistId) {
    return res.render('shuffle', {
      message: 'No playlist selected.',
      playlist_name: null,
      playlist_image: null,
      tracks: []
    });
  }

  try {
    const tracks = await getPlaylistTracks(sp, playlistId);
    if (!tracks.length) {
      return res.render('shuffle', {
        message: 'No tracks found in this playlist.',
        playlist_name: null,
        playlist_image: null,
        tracks: []
      });
    }

    shuffleArray(tracks);
    const uris = tracks.map(t => t.uri);

    await sp.play({ uris });

    const playlistData = await sp.getPlaylist(playlistId);

    res.render('shuffle', {
      message: 'Shuffling and playback started!',
      playlist_name: playlistData.body.name,
      playlist_image: playlistData.body.images[0]?.url || null,
      tracks
    });

  } catch (err) {
    res.render('shuffle', {
      message:
        'No active Spotify device found. Please open Spotify on one of your devices and try again.',
      playlist_name: null,
      playlist_image: null,
      tracks: []
    });
  }
});


app.get('/playlist/:id', async (req, res) => {
  const sp = getSpotifyFromSession(req);
  if (!sp) return res.redirect('/login');

  try {
    const tracks = await getPlaylistTracks(sp, req.params.id);
    res.render('playlist', { tracks });
  } catch (err) {
    res.send('Error loading playlist');
  }
});

/* -------------------------
   Start server
------------------------- */

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
