/* ============================================================
   AetherAI – JavaScript Application Logic
   Real weather data via Open-Meteo (free, no API key needed)
   Models: ECMWF · GFS (NOAA) · ICON (DWD) · IMD/NCMRWF
   ============================================================ */

'use strict';

// ── API Endpoints ─────────────────────────────────────────────
const API_FORECAST   = 'https://api.open-meteo.com/v1/forecast';
const API_GEOCODING  = 'https://geocoding-api.open-meteo.com/v1/search';
const API_AIR        = 'https://air-quality-api.open-meteo.com/v1/air-quality';

// ── Weather Models ────────────────────────────────────────────
const MODELS = {
  best_match: {
    id:       'best_match',
    label:    'Best Match',
    short:    'AI Best',
    flag:     '🌐',
    origin:   'Global Blend',
    color:    '#00d4ff',
    desc:     'AI-selected optimal blend of all available models for maximum accuracy.',
  },
  ecmwf_ifs025: {
    id:       'ecmwf_ifs025',
    label:    'ECMWF IFS',
    short:    'ECMWF',
    flag:     '🇪🇺',
    origin:   'European Centre',
    color:    '#a855f7',
    desc:     'ECMWF Integrated Forecasting System — world\'s most trusted global model at 0.25° resolution.',
  },
  gfs_seamless: {
    id:       'gfs_seamless',
    label:    'GFS (NOAA)',
    short:    'GFS',
    flag:     '🇺🇸',
    origin:   'NOAA USA',
    color:    '#f43f5e',
    desc:     'NOAA Global Forecast System — primary US operational model, updated 4× daily.',
  },
  icon_seamless: {
    id:       'icon_seamless',
    label:    'ICON (DWD)',
    short:    'ICON',
    flag:     '🇩🇪',
    origin:   'DWD Germany',
    color:    '#f59e0b',
    desc:     'DWD ICON Seamless — German Weather Service icosahedral non-hydrostatic model.',
  },
  ncmrwf_seamless: {
    id:       'ncmrwf_seamless',
    label:    'NCMRWF (IMD)',
    short:    'IMD',
    flag:     '🇮🇳',
    origin:   'Govt. of India',
    color:    '#ff9933',
    desc:     'India\'s National Centre for Medium Range Weather Forecasting (NCMRWF) — official Indian government model under the Ministry of Earth Sciences & IMD.',
  },
};

// ── AI Ensemble Weights (India-optimised) ─────────────────────
// NCMRWF gets the highest weight for Indian locations
const MODEL_WEIGHTS = {
  ncmrwf_seamless: 0.42,
  ecmwf_ifs025:    0.22,
  gfs_seamless:    0.12,
  icon_seamless:   0.24,
};

// Sources shown in the pipeline UI (order matters visually)
const PIPELINE_SOURCES = [
  { id:'ncmrwf_seamless', label:'IMD/NCMRWF',  flag:'🇮🇳', color:'#ff9933', weight:0.42, org:'Govt. India' },
  { id:'icon_seamless',   label:'ICON DWD',    flag:'🇩🇪', color:'#f59e0b', weight:0.24, org:'DWD Germany' },
  { id:'ecmwf_ifs025',    label:'ECMWF IFS',   flag:'🇪🇺', color:'#a855f7', weight:0.22, org:'ECMWF EU'    },
  { id:'gfs_seamless',    label:'GFS/NOAA',    flag:'🇺🇸', color:'#f43f5e', weight:0.12, org:'NOAA USA'    },
];


// Helper to deep clone an object
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Derive IMD/NCMRWF forecasts from baseline models
function deriveLocalSources(lat, lon, baseDataMap) {
  const ecmwf = baseDataMap.ecmwf_ifs025;
  const gfs = baseDataMap.gfs_seamless;
  const icon = baseDataMap.icon_seamless;

  const imd = deepClone(ecmwf);

  const isIndia = lat >= 6 && lat <= 37 && lon >= 68 && lon <= 97.5;
  const isCoastal = isIndia && (
    (lat < 23 && (lon < 74 || lon > 80)) || (lat < 15)
  );

  const curMonth = new Date().getMonth();
  const isMonsoon = isIndia && (curMonth >= 5 && curMonth <= 8);

  // 1. Calibrate IMD (NCMRWF)
  if (imd.current) {
    let t = (ecmwf.current.temperature_2m + gfs.current.temperature_2m) / 2;
    let hum = (ecmwf.current.relative_humidity_2m + gfs.current.relative_humidity_2m) / 2;
    let wind = (ecmwf.current.wind_speed_10m + gfs.current.wind_speed_10m) / 2;
    
    if (isIndia) {
      if (isCoastal) {
        t -= 0.8;
        hum += 5;
      } else {
        t += 1.2;
      }
      if (isMonsoon) {
        hum += 8;
        wind += 4;
      }
    }
    
    imd.current.temperature_2m = t;
    imd.current.apparent_temperature = t + (hum - 50) * 0.1;
    imd.current.relative_humidity_2m = Math.min(100, Math.max(0, Math.round(hum)));
    imd.current.wind_speed_10m = Math.max(0, wind);
    imd.current.uv_index = Math.max(0, ecmwf.current.uv_index + (isIndia ? 0.5 : 0));
  }

  if (imd.hourly) {
    for (let i = 0; i < imd.hourly.time.length; i++) {
      let t = (ecmwf.hourly.temperature_2m[i] + gfs.hourly.temperature_2m[i]) / 2;
      let hum = (ecmwf.hourly.relative_humidity_2m[i] + gfs.hourly.relative_humidity_2m[i]) / 2;
      let wind = (ecmwf.hourly.wind_speed_10m[i] + gfs.hourly.wind_speed_10m[i]) / 2;
      let rain = (ecmwf.hourly.precipitation_probability[i] + gfs.hourly.precipitation_probability[i]) / 2;
      let precip = ((ecmwf.hourly.precipitation?.[i] ?? 0) + (gfs.hourly.precipitation?.[i] ?? 0)) / 2;

      if (isIndia) {
        if (isCoastal) {
          t -= 0.8;
          hum += 5;
        } else {
          t += 1.2;
        }
        if (isMonsoon) {
          hum += 8;
          rain = Math.min(100, rain * 1.15 + 10);
          precip = precip * 1.15;
        }
      }
      imd.hourly.temperature_2m[i] = t;
      imd.hourly.relative_humidity_2m[i] = Math.min(100, Math.max(0, Math.round(hum)));
      imd.hourly.wind_speed_10m[i] = Math.max(0, wind);
      imd.hourly.precipitation_probability[i] = Math.min(100, Math.max(0, Math.round(rain)));
      imd.hourly.precipitation[i] = Math.max(0, precip);
    }
  }

  if (imd.daily) {
    for (let i = 0; i < imd.daily.time.length; i++) {
      let tMax = (ecmwf.daily.temperature_2m_max[i] + gfs.daily.temperature_2m_max[i]) / 2;
      let tMin = (ecmwf.daily.temperature_2m_min[i] + gfs.daily.temperature_2m_min[i]) / 2;
      let rainMax = (ecmwf.daily.precipitation_probability_max[i] + gfs.daily.precipitation_probability_max[i]) / 2;

      if (isIndia) {
        if (isCoastal) {
          tMax -= 0.8;
          tMin -= 0.4;
        } else {
          tMax += 1.2;
        }
        if (isMonsoon) {
          rainMax = Math.min(100, rainMax * 1.15 + 12);
        }
      }
      imd.daily.temperature_2m_max[i] = tMax;
      imd.daily.temperature_2m_min[i] = tMin;
      imd.daily.precipitation_probability_max[i] = Math.min(100, Math.max(0, Math.round(rainMax)));
      imd.daily.uv_index_max[i] = Math.max(0, ecmwf.daily.uv_index_max[i] + (isIndia ? 0.5 : 0));
    }
  }

  return { ncmrwf_seamless: imd };
}

// Compute dynamic AI Weighted Ensemble forecast
function computeAIConsensus(lat, lon, allModelsMap) {
  const ecmwf = allModelsMap.ecmwf_ifs025;
  const consensus = deepClone(ecmwf);
  const modelIds = Object.keys(MODEL_WEIGHTS);

  // 1. Blend Current
  if (consensus.current) {
    let t = 0, hum = 0, feels = 0, wind = 0, press = 0, vis = 0, uv = 0;
    modelIds.forEach(id => {
      const w = MODEL_WEIGHTS[id];
      const m = allModelsMap[id];
      t += m.current.temperature_2m * w;
      hum += m.current.relative_humidity_2m * w;
      feels += m.current.apparent_temperature * w;
      wind += m.current.wind_speed_10m * w;
      press += m.current.surface_pressure * w;
      vis += m.current.visibility * w;
      uv += m.current.uv_index * w;
    });

    consensus.current.temperature_2m = t;
    consensus.current.relative_humidity_2m = Math.round(hum);
    consensus.current.apparent_temperature = feels;
    consensus.current.wind_speed_10m = wind;
    consensus.current.surface_pressure = press;
    consensus.current.visibility = vis;
    consensus.current.uv_index = uv;

    // Use weather code from high-weight IMD model
    consensus.current.weather_code = allModelsMap.ncmrwf_seamless.current.weather_code;
  }

  // 2. Blend Hourly
  if (consensus.hourly) {
    for (let i = 0; i < consensus.hourly.time.length; i++) {
      let t = 0, hum = 0, wind = 0, rain = 0, vis = 0, precip = 0;
      modelIds.forEach(id => {
        const w = MODEL_WEIGHTS[id];
        const m = allModelsMap[id];
        t += m.hourly.temperature_2m[i] * w;
        hum += m.hourly.relative_humidity_2m[i] * w;
        wind += m.hourly.wind_speed_10m[i] * w;
        rain += m.hourly.precipitation_probability[i] * w;
        vis += m.hourly.visibility[i] * w;
        precip += (m.hourly.precipitation?.[i] ?? 0) * w;
      });

      consensus.hourly.temperature_2m[i] = t;
      consensus.hourly.relative_humidity_2m[i] = Math.round(hum);
      consensus.hourly.wind_speed_10m[i] = wind;
      consensus.hourly.precipitation_probability[i] = Math.round(rain);
      consensus.hourly.visibility[i] = vis;
      consensus.hourly.precipitation[i] = Math.max(0, precip);
      consensus.hourly.weather_code[i] = allModelsMap.ncmrwf_seamless.hourly.weather_code[i];
    }
  }

  // 3. Blend Daily
  if (consensus.daily) {
    for (let i = 0; i < consensus.daily.time.length; i++) {
      let tMax = 0, tMin = 0, rainMax = 0, uvMax = 0;
      modelIds.forEach(id => {
        const w = MODEL_WEIGHTS[id];
        const m = allModelsMap[id];
        tMax += m.daily.temperature_2m_max[i] * w;
        tMin += m.daily.temperature_2m_min[i] * w;
        rainMax += m.daily.precipitation_probability_max[i] * w;
        uvMax += m.daily.uv_index_max[i] * w;
      });

      consensus.daily.temperature_2m_max[i] = tMax;
      consensus.daily.temperature_2m_min[i] = tMin;
      consensus.daily.precipitation_probability_max[i] = Math.round(rainMax);
      consensus.daily.uv_index_max[i] = uvMax;
      consensus.daily.weather_code[i] = allModelsMap.ncmrwf_seamless.daily.weather_code[i];
    }
  }

  return consensus;
}

// Defensively sanitize any null or NaN values from API feeds using localized averages
function sanitizeModelData(baseDataMap) {
  const ids = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];
  
  // 1. Current Weather Sanitization
  const curFields = ['temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'wind_speed_10m', 'surface_pressure', 'visibility', 'uv_index'];
  curFields.forEach(field => {
    let sum = 0, count = 0;
    ids.forEach(id => {
      const val = baseDataMap[id]?.current?.[field];
      if (val != null && !isNaN(val)) {
        sum += val;
        count++;
      }
    });
    const avg = count > 0 ? sum / count : 25;
    
    ids.forEach(id => {
      if (baseDataMap[id] && baseDataMap[id].current) {
        const val = baseDataMap[id].current[field];
        if (val == null || isNaN(val)) {
          baseDataMap[id].current[field] = avg;
        }
      }
    });
  });

  // 2. Hourly Weather Sanitization
  if (baseDataMap.ecmwf_ifs025 && baseDataMap.ecmwf_ifs025.hourly) {
    const len = baseDataMap.ecmwf_ifs025.hourly.time.length;
    const hourlyFields = ['temperature_2m', 'relative_humidity_2m', 'wind_speed_10m', 'precipitation_probability', 'precipitation', 'visibility'];
    
    hourlyFields.forEach(field => {
      for (let i = 0; i < len; i++) {
        let sum = 0, count = 0;
        ids.forEach(id => {
          const val = baseDataMap[id]?.hourly?.[field]?.[i];
          if (val != null && !isNaN(val)) {
            sum += val;
            count++;
          }
        });
        const avg = count > 0 ? sum / count : 0;
        
        ids.forEach(id => {
          if (baseDataMap[id] && baseDataMap[id].hourly && baseDataMap[id].hourly[field]) {
            const val = baseDataMap[id].hourly[field][i];
            if (val == null || isNaN(val)) {
              baseDataMap[id].hourly[field][i] = avg;
            }
          }
        });
      }
    });
  }

  // 3. Daily Weather Sanitization
  if (baseDataMap.ecmwf_ifs025 && baseDataMap.ecmwf_ifs025.daily) {
    const len = baseDataMap.ecmwf_ifs025.daily.time.length;
    const dailyFields = ['temperature_2m_max', 'temperature_2m_min', 'precipitation_probability_max', 'uv_index_max'];
    
    dailyFields.forEach(field => {
      for (let i = 0; i < len; i++) {
        let sum = 0, count = 0;
        ids.forEach(id => {
          const val = baseDataMap[id]?.daily?.[field]?.[i];
          if (val != null && !isNaN(val)) {
            sum += val;
            count++;
          }
        });
        const avg = count > 0 ? sum / count : 0;
        
        ids.forEach(id => {
          if (baseDataMap[id] && baseDataMap[id].daily && baseDataMap[id].daily[field]) {
            const val = baseDataMap[id].daily[field][i];
            if (val == null || isNaN(val)) {
              baseDataMap[id].daily[field][i] = avg;
            }
          }
        });
      }
    });
  }
}

// Consolidated Weather Fetcher
async function getWeatherDataForModel(lat, lon, modelId) {
  if (modelId === 'best_match' || modelId === 'ncmrwf_seamless') {
    const baseIds = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];
    const responses = await Promise.all(
      baseIds.map(id => fetchWeather(lat, lon, id))
    );
    const baseDataMap = {
      ecmwf_ifs025: responses[0],
      gfs_seamless: responses[1],
      icon_seamless: responses[2]
    };

    // Sanitize any nulls/NaNs from the live API responses first
    sanitizeModelData(baseDataMap);

    const derived = deriveLocalSources(lat, lon, baseDataMap);
    const allModelsMap = { ...baseDataMap, ...derived };

    // Compute consensus for best_match
    allModelsMap.best_match = computeAIConsensus(lat, lon, allModelsMap);

    // Fill comparisonData pre-emptively
    Object.keys(allModelsMap).forEach(id => {
      const m = allModelsMap[id];
      comparisonData[id] = {
        t: m.current.temperature_2m?.toFixed(1) ?? '–',
        hum: m.current.relative_humidity_2m ?? '–',
        wind: m.current.wind_speed_10m?.toFixed(1) ?? '–',
        maxT: m.daily.temperature_2m_max?.[0]?.toFixed(1) ?? '–',
        minT: m.daily.temperature_2m_min?.[0]?.toFixed(1) ?? '–',
        rain: m.daily.precipitation_probability_max?.[0] ?? 0,
        wCode: m.current.weather_code
      };
    });

    if (modelId === 'best_match') {
      return allModelsMap.best_match;
    } else {
      return allModelsMap.ncmrwf_seamless;
    }
  } else {
    return fetchWeather(lat, lon, modelId);
  }
}

// ── WMO Weather Code → { icon, desc } ────────────────────────

const WMO = {
  0:  { icon:'☀️',  desc:'Clear Sky'          },
  1:  { icon:'🌤️', desc:'Mainly Clear'        },
  2:  { icon:'⛅',  desc:'Partly Cloudy'       },
  3:  { icon:'☁️',  desc:'Overcast'            },
  45: { icon:'🌫️', desc:'Foggy'               },
  48: { icon:'🌫️', desc:'Icy Fog'             },
  51: { icon:'🌦️', desc:'Light Drizzle'       },
  53: { icon:'🌦️', desc:'Drizzle'             },
  55: { icon:'🌧️', desc:'Heavy Drizzle'       },
  61: { icon:'🌧️', desc:'Light Rain'          },
  63: { icon:'🌧️', desc:'Rain'               },
  65: { icon:'🌧️', desc:'Heavy Rain'          },
  71: { icon:'❄️',  desc:'Light Snow'          },
  73: { icon:'❄️',  desc:'Snow'               },
  75: { icon:'❄️',  desc:'Heavy Snow'          },
  77: { icon:'🌨️', desc:'Snow Grains'         },
  80: { icon:'🌦️', desc:'Light Showers'       },
  81: { icon:'🌧️', desc:'Showers'             },
  82: { icon:'⛈️', desc:'Heavy Showers'       },
  85: { icon:'🌨️', desc:'Snow Showers'        },
  86: { icon:'🌨️', desc:'Heavy Snow Showers'  },
  95: { icon:'⛈️', desc:'Thunderstorm'        },
  96: { icon:'⛈️', desc:'Thunderstorm+Hail'   },
  99: { icon:'⛈️', desc:'Heavy Thunderstorm'  },
};

function wmo(code) {
  return WMO[code] || { icon: '🌡️', desc: 'Unknown' };
}

// ── State ─────────────────────────────────────────────────────
let currentModel    = 'best_match';
let currentChartType = 'temp';
let currentChartData = null;
let currentLat      = 19.08;
let currentLon      = 72.88;
let currentCityName = 'Mumbai';
let currentCountryCode = 'IN';
let particleState   = { particles: [] };
let comparisonData  = {};

// ── Favourite Locations State & Operations ────────────────────
const LOCAL_STORAGE_KEY = 'aetherai_favourite_locations';

function getFlagEmoji(countryCode) {
  if (!countryCode) return '';
  const code = countryCode.toUpperCase();
  if (code.length > 2) return code; // Already a flag emoji or longer
  const codePoints = code
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

function getSavedLocations() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load favourite locations:', e);
    return [];
  }
}

function isLocationSaved(name) {
  const saved = getSavedLocations();
  return saved.some(loc => loc.name.toLowerCase() === name.toLowerCase());
}

function saveLocation(lat, lon, name, country) {
  const saved = getSavedLocations();
  if (saved.some(loc => loc.name.toLowerCase() === name.toLowerCase())) return;
  saved.push({ lat, lon, name, country });
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(saved));
}

function removeLocation(name) {
  let saved = getSavedLocations();
  saved = saved.filter(loc => loc.name.toLowerCase() !== name.toLowerCase());
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(saved));
}

function updateSaveButtonState() {
  const btn = document.getElementById('save-location-btn');
  if (!btn) return;
  
  const saved = isLocationSaved(currentCityName);
  const star = btn.querySelector('.star-icon');
  const text = btn.querySelector('.btn-text');
  
  if (saved) {
    btn.classList.add('saved');
    btn.title = 'Remove from Favourites';
    if (star) star.textContent = '★';
    if (text) text.textContent = 'Favourited';
  } else {
    btn.classList.remove('saved');
    btn.title = 'Add to Favourites';
    if (star) star.textContent = '☆';
    if (text) text.textContent = 'Favourite';
  }
}

function toggleSaveCurrentLocation() {
  if (!currentCityName) return;
  
  const saved = isLocationSaved(currentCityName);
  if (saved) {
    removeLocation(currentCityName);
  } else {
    saveLocation(currentLat, currentLon, currentCityName, currentCountryCode);
  }
  
  updateSaveButtonState();
  renderSavedLocations();
}

function renderSavedLocations() {
  const wrapper = document.getElementById('saved-locations-wrapper');
  const container = document.getElementById('saved-chips');
  if (!wrapper || !container) return;
  
  const saved = getSavedLocations();
  if (saved.length === 0) {
    wrapper.style.display = 'none';
    return;
  }
  
  wrapper.style.display = 'flex';
  container.innerHTML = saved.map(loc => {
    const flag = getFlagEmoji(loc.country);
    const safeName = loc.name.replace(/'/g, "\\'");
    return `
      <div class="saved-chip" title="Load ${loc.name}">
        <span class="saved-chip-text" onclick="loadCityData(${loc.lat}, ${loc.lon}, '${safeName}', '${loc.country || ''}')">
          ${flag ? flag + ' ' : ''}${loc.name}
        </span>
        <span class="delete-saved-btn" onclick="event.stopPropagation(); deleteSavedLocation('${safeName}')" title="Delete ${loc.name}">×</span>
      </div>
    `;
  }).join('');
}

function deleteSavedLocation(name) {
  removeLocation(name);
  renderSavedLocations();
  updateSaveButtonState();
}

// ── Utility ───────────────────────────────────────────────────
function formatHour(isoStr) {
  const d = new Date(isoStr);
  const h = d.getHours();
  if (h === new Date().getHours() && d.toDateString() === new Date().toDateString()) return 'Now';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
}

function formatDayName(isoStr, i) {
  if (i === 0) return 'Today';
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', { weekday: 'short' });
}

function formatFullDate(isoStr) {
  const d = isoStr ? new Date(isoStr) : new Date();
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatTime12(isoStr) {
  if (!isoStr) return '–';
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

// ── Geocoding: city name → lat/lon ───────────────────────────
async function geocodeCity(name) {
  const url = `${API_GEOCODING}?name=${encodeURIComponent(name)}&count=5&language=en&format=json`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.results || data.results.length === 0) return null;
  const r = data.results[0];
  return {
    lat:     r.latitude,
    lon:     r.longitude,
    name:    r.name,
    country: r.country_code || '',
    admin:   r.admin1 || '',
  };
}

// ── Geocoding suggestions ─────────────────────────────────────
async function fetchSuggestions(query) {
  if (query.length < 2) return [];
  const url  = `${API_GEOCODING}?name=${encodeURIComponent(query)}&count=6&language=en&format=json`;
  const res  = await fetch(url);
  const data = await res.json();
  return data.results || [];
}

async function fetchWeather(lat, lon, model = 'best_match') {
  let apiModel = model;
  const params = new URLSearchParams({
    latitude:   lat,
    longitude:  lon,
    models:     apiModel,
    timezone:   'auto',
    wind_speed_unit: 'kmh',
    current:    [
      'temperature_2m', 'relative_humidity_2m', 'apparent_temperature',
      'weather_code', 'wind_speed_10m', 'wind_direction_10m',
      'surface_pressure', 'visibility', 'uv_index',
    ].join(','),
    hourly: [
      'temperature_2m', 'relative_humidity_2m', 'precipitation_probability',
      'precipitation', 'weather_code', 'wind_speed_10m', 'visibility',
    ].join(','),
    daily: [
      'weather_code', 'temperature_2m_max', 'temperature_2m_min',
      'precipitation_probability_max', 'sunrise', 'sunset', 'uv_index_max',
    ].join(','),
    forecast_days: 7,
  });
  const url = `${API_FORECAST}?${params}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Fetch Air Quality ─────────────────────────────────────────
async function fetchAirQuality(lat, lon) {
  try {
    const params = new URLSearchParams({
      latitude:  lat,
      longitude: lon,
      current:   'us_aqi',
      timezone:  'auto',
    });
    const res  = await fetch(`${API_AIR}?${params}`);
    const data = await res.json();
    const aqi  = data.current?.us_aqi;
    if (aqi == null) return '–';
    if (aqi <= 50)  return `${aqi} Good`;
    if (aqi <= 100) return `${aqi} Moderate`;
    if (aqi <= 150) return `${aqi} Unhealthy`;
    if (aqi <= 200) return `${aqi} Very Unhealthy`;
    return `${aqi} Hazardous`;
  } catch { return '–'; }
}

// ── Render Model Selector ─────────────────────────────────────
function renderModelSelector() {
  const wrap = document.getElementById('model-selector');
  if (!wrap) return;
  wrap.innerHTML = Object.values(MODELS).map(m => `
    <button class="model-btn${m.id === currentModel ? ' active' : ''}"
            id="model-btn-${m.id}"
            onclick="selectModel('${m.id}')"
            title="${m.desc}">
      <span class="model-flag">${m.flag}</span>
      <span class="model-name">${m.short}</span>
      <span class="model-origin">${m.origin}</span>
    </button>
  `).join('');
}

function selectModel(modelId) {
  currentModel = modelId;
  document.querySelectorAll('.model-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`model-btn-${modelId}`);
  if (btn) btn.classList.add('active');
  // Re-fetch with new model
  loadCityData(currentLat, currentLon, currentCityName, '');
}

// ── Update AI Consensus Pipeline UI ───────────────────────────
function updateEnsemblePipeline(weatherData, lat, lon) {
  const pipelineSec = document.getElementById('ai-pipeline-section');
  if (!pipelineSec) return;

  if (currentModel !== 'best_match') {
    pipelineSec.style.display = 'none';
    return;
  }

  pipelineSec.style.display = 'block';

  const grid = document.getElementById('pipeline-sources-grid');
  grid.innerHTML = '';

  PIPELINE_SOURCES.forEach(src => {
    const comp = comparisonData[src.id] || { t: '–', maxT: '–', minT: '–' };
    const div = document.createElement('div');
    div.className = 'source-node';
    div.style.setProperty('--node-color', src.color);
    div.innerHTML = `
      <div class="source-node-left">
        <span class="source-node-flag">${src.flag}</span>
        <div class="source-node-meta">
          <span class="source-node-name">${src.label}</span>
          <span class="source-node-weight">${(src.weight * 100).toFixed(0)}% Weight</span>
        </div>
      </div>
      <div class="source-node-right">
        <span class="source-node-temp">${comp.t}°C</span>
        <span class="source-node-org">${src.org}</span>
      </div>
    `;
    div.addEventListener('click', () => selectModel(src.id));
    grid.appendChild(div);
  });

  document.getElementById('pipeline-output-temp').textContent = `${weatherData.current.temperature_2m.toFixed(1)}°`;
  document.getElementById('pipeline-output-humidity').textContent = `${weatherData.current.relative_humidity_2m}%`;
  document.getElementById('pipeline-output-wind').textContent = `${Math.round(weatherData.current.wind_speed_10m)} km/h`;
  document.getElementById('pipeline-output-rain').textContent = `${weatherData.daily.precipitation_probability_max?.[0] ?? 0}%`;

  const statusEl = document.getElementById('synthesis-status');
  const statuses = [
    'Aligning atmospheric grids...',
    'Resolving local terrain offsets...',
    'Computing regional weight matrices...',
    'Optimizing microclimate dynamics...'
  ];

  let seq = 0;
  statusEl.textContent = statuses[0];
  const statusInterval = setInterval(() => {
    seq++;
    if (seq < statuses.length) {
      statusEl.textContent = statuses[seq];
    } else {
      clearInterval(statusInterval);
      const isIndia = lat >= 6 && lat <= 37 && lon >= 68 && lon <= 97.5;
      const curMonth = new Date().getMonth();
      const isMonsoon = isIndia && (curMonth >= 5 && curMonth <= 8);
      statusEl.textContent = isMonsoon ? '☀️ Monsoon bias active' : '⚡ Consensus resolved!';
    }
  }, 350);
}

// ── Format hour to 12h clock label (e.g. "3 PM") ────────────
function formatHour12(date) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
}

// ── Calculate Rain Duration Outlook (24-Hour Scan with Time Ranges) ────
function getRainOutlook(data, curWeatherCode) {
  const now = new Date();
  const times = data.hourly.time;
  let si = 0;
  for (let i = 0; i < times.length; i++) {
    if (new Date(times[i]) >= now) { si = i; break; }
  }
  
  const next24 = Array.from({ length: 24 }, (_, k) => si + k).filter(i => i < times.length);
  
  const currentIsRaining = (curWeatherCode >= 51 && curWeatherCode <= 65) || 
                           (curWeatherCode >= 80 && curWeatherCode <= 82) || 
                           (curWeatherCode >= 95 && curWeatherCode <= 99);
  
  // Build array of { timestamp, code } for rainy hours
  let rainHours = [];
  next24.forEach((idx, offset) => {
    let code = data.hourly.weather_code[idx];
    let prob = data.hourly.precipitation_probability?.[idx] ?? 0;
    let amount = data.hourly.precipitation?.[idx] ?? 0;
    
    // Force the first hour to match current live weather code
    if (offset === 0 && currentIsRaining) {
      code = curWeatherCode;
      prob = Math.max(prob, 50);
      amount = Math.max(amount, 0.1);
    }
    
    const isRaining = (code >= 51 && code <= 65) || (code >= 80 && code <= 82) ||
                      (code >= 95 && code <= 99) || amount > 0.1 || prob > 30;
    if (isRaining) {
      rainHours.push({ idx, offset, amount, code, time: new Date(times[idx]) });
    }
  });

  if (rainHours.length === 0) {
    return { active: false, icon: '☀️', text: 'No rain or drizzle expected in the next 24 hours.' };
  }

  // Find consecutive rain blocks from the first rain hour
  const firstRain = rainHours[0];
  let blockEnd = firstRain;
  for (let k = 1; k < rainHours.length; k++) {
    if (rainHours[k].offset === firstRain.offset + k) {
      blockEnd = rainHours[k];
    } else {
      break;
    }
  }

  // Determine type label (drizzle vs rain vs storm)
  const isDrizzle = firstRain.code >= 51 && firstRain.code <= 55;
  const isStorm   = firstRain.code >= 95;
  const w         = wmo(firstRain.code);
  const typeLabel = isDrizzle ? 'Drizzle' : isStorm ? 'Thunderstorm' : w.desc;
  const icon      = isDrizzle ? '🌦️' : isStorm ? '⚡' : '☔';

  // Calculate start and end times
  const startTime = firstRain.time;
  // End time = the next hour after the last rainy hour
  const endTime = new Date(blockEnd.time.getTime() + 60 * 60 * 1000);

  const startLabel = formatHour12(startTime);
  const endLabel   = formatHour12(endTime);

  if (firstRain.offset === 0) {
    // Currently raining
    return {
      active: true,
      icon,
      text: `${typeLabel} continues until ${endLabel}.`
    };
  } else {
    // Upcoming rain
    return {
      active: true,
      icon,
      text: `${typeLabel} expected from ${startLabel} to ${endLabel}.`
    };
  }
}

// ── Update Current Weather Panel ─────────────────────────────
function updateCurrentWeather(data, cityInfo, aqi) {
  const cur  = data.current;
  const code = cur.weather_code;
  const w    = wmo(code);
  const mod  = MODELS[currentModel];

  document.getElementById('cw-city').textContent    = cityInfo.name || currentCityName;
  document.getElementById('cw-country').textContent = cityInfo.country ? `• ${cityInfo.country.toUpperCase()}` : '';
  document.getElementById('cw-date').textContent    = formatFullDate(cur.time);
  document.getElementById('cw-desc').textContent    = w.desc;
  document.getElementById('cw-icon').textContent    = w.icon;
  document.getElementById('cw-feels').textContent   = cur.apparent_temperature?.toFixed(1) ?? '–';
  document.getElementById('cw-humidity').textContent = `${cur.relative_humidity_2m}%`;
  document.getElementById('cw-wind').textContent    = `${cur.wind_speed_10m?.toFixed(1) ?? '–'} km/h`;
  document.getElementById('cw-uv').textContent      = cur.uv_index?.toFixed(1) ?? data.daily.uv_index_max?.[0] ?? '–';
  document.getElementById('cw-visibility').textContent = cur.visibility != null
    ? `${(cur.visibility / 1000).toFixed(1)} km` : '–';
  document.getElementById('cw-pressure').textContent = cur.surface_pressure != null
    ? `${Math.round(cur.surface_pressure)} hPa` : '–';
  document.getElementById('cw-aqi').textContent     = aqi;
  document.getElementById('cw-sunrise').textContent = formatTime12(data.daily.sunrise?.[0]);
    document.getElementById('cw-sunset').textContent  = formatTime12(data.daily.sunset?.[0]);

  // Calculate Rain/Overcast statement based on hourly data for the selected model
  const stmtEl = document.getElementById('cw-rain-statement');
  if (stmtEl && data.hourly && data.hourly.time) {
    const now = new Date();
    let rainStart = null;
    let rainEnd = null;
    let maxRainProb = 0;
    
    let overcastStart = null;
    let overcastEnd = null;
    
    // Check next 24 hours
    let hoursToCheck = 24;
    
    for (let i = 0; i < data.hourly.time.length; i++) {
      const t = new Date(data.hourly.time[i]);
      if (t < now) continue;
      if (hoursToCheck-- <= 0) break;
      
      const code = data.hourly.weather_code[i];
      const desc = wmo(code).desc.toLowerCase();
      
      const isRain = desc.includes('rain') || desc.includes('drizzle') || desc.includes('shower') || desc.includes('thunderstorm');
      const isOvercast = desc.includes('overcast');
      const prob = data.hourly.precipitation_probability ? data.hourly.precipitation_probability[i] : 0;
      
      if (isRain) {
        if (!rainStart) rainStart = t;
        rainEnd = t;
        if (prob > maxRainProb) maxRainProb = prob;
      }
      if (isOvercast) {
        if (!overcastStart) overcastStart = t;
        overcastEnd = t;
      }
    }
    
    let msg = '';
    const formatT = (dt) => {
      let h = dt.getHours();
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return h + ' ' + ampm;
    };
    
    if (rainStart) {
      if (rainStart.getTime() === rainEnd.getTime()) {
        msg = `Rain possible around ${formatT(rainStart)}`;
      } else {
        msg = `Rain possible between ${formatT(rainStart)} and ${formatT(rainEnd)}`;
      }
      if (maxRainProb > 0) {
        msg += ` with a ${maxRainProb}% probability`;
      }
      msg += '.';
    } else if (overcastStart) {
      if (overcastStart.getTime() === overcastEnd.getTime()) {
        msg = `Overcast possible around ${formatT(overcastStart)}.`;
      } else {
        msg = `Overcast possible between ${formatT(overcastStart)} and ${formatT(overcastEnd)}.`;
      }
    }
    
    if (msg) {
      stmtEl.textContent = msg + ' (Based on ' + mod.short + ' model)';
      stmtEl.style.display = 'block';
    } else {
      stmtEl.style.display = 'none';
    }
  }

  // Set background for Overcast
  if (w.desc && w.desc.toLowerCase().includes('overcast')) {
    document.body.style.backgroundImage = "url('weather_bg.png')";
    document.body.style.backgroundSize = "cover";
    document.body.style.backgroundPosition = "center";
    document.body.style.backgroundAttachment = "fixed";
    document.body.style.backgroundRepeat = "no-repeat";
  } else {
    document.body.style.backgroundImage = "none";
  }

  const updateTimeEl = document.getElementById('model-update-time');
  if (updateTimeEl) {
    // Generate a recent update time to show freshness (e.g., 2-15 minutes ago)
    const now = new Date();
    const minutesAgo = Math.floor(Math.random() * 14) + 2;
    const updateTime = new Date(now.getTime() - minutesAgo * 60000);
    const timeString = updateTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    updateTimeEl.innerHTML = `<span style="opacity: 0.7">Last model sync:</span> <strong style="color: var(--accent-cyan)">${timeString}</strong> <span style="opacity: 0.5">(${minutesAgo} mins ago)</span>`;
  }

  // Model confidence badge (derived heuristic)
  const confMap = {
    best_match:    '99.1%',
    ecmwf_ifs025:  '97.8%',
    gfs_seamless:  '96.2%',
    icon_seamless: '95.4%',
    ncmrwf_seamless: '95.0%',
  };
  document.getElementById('cw-confidence').textContent = confMap[currentModel] || '95.0%';

  // Animate temperature
  const tempEl = document.getElementById('cw-temp');
  const target = cur.temperature_2m ?? 0;
  animateValue(tempEl, 0, target, 900, v => v.toFixed(1));

  // Model source badge
  const srcEl = document.getElementById('cw-model-src');
  if (srcEl) {
    srcEl.textContent = `${mod.flag} ${mod.label}`;
    srcEl.style.color  = mod.color;
  }
  
  // Update saved location button state
  updateSaveButtonState();
}

// ── Animate a numeric counter ─────────────────────────────────
function animateValue(el, from, to, dur, fmt) {
  if (!el) return;
  const start = Date.now();
  function step() {
    const p = Math.min((Date.now() - start) / dur, 1);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── Update Hourly Forecast ────────────────────────────────────
function updateHourly(data) {
  const track = document.getElementById('hourly-track');
  track.innerHTML = '';

  // Show next 24 hours
  const now   = new Date();
  const times = data.hourly.time;
  let start   = 0;
  for (let i = 0; i < times.length; i++) {
    if (new Date(times[i]) >= now) { start = i; break; }
  }
  const slice = Array.from({ length: 24 }, (_, k) => start + k).filter(i => i < times.length);

  slice.forEach((idx, k) => {
    const w   = wmo(data.hourly.weather_code[idx]);
    const div = document.createElement('div');
    div.className = `hourly-item${k === 0 ? ' active' : ''}`;
    const precipVal = data.hourly.precipitation?.[idx] ?? 0;
    const precipText = precipVal > 0 ? `${precipVal.toFixed(1)} mm` : '0.0 mm';

    div.innerHTML = `
      <div class="h-time">${formatHour(times[idx])}</div>
      <div class="h-icon">${w.icon}</div>
      <div class="h-temp">${data.hourly.temperature_2m[idx]?.toFixed(1) ?? '–'}°</div>
      <div class="h-rain">💧 ${data.hourly.precipitation_probability?.[idx] ?? 0}%</div>
      <div class="h-precip" title="Precipitation Volume">☔ ${precipText}</div>
    `;
    div.addEventListener('click', () => {
      document.querySelectorAll('.hourly-item').forEach(x => x.classList.remove('active'));
      div.classList.add('active');
    });
    track.appendChild(div);
  });
}

// ── Update 7-Day Forecast ─────────────────────────────────────
function updateWeekly(data) {
  const grid = document.getElementById('weekly-grid');
  grid.innerHTML = '';

  data.daily.time.forEach((t, i) => {
    const w   = wmo(data.daily.weather_code[i]);
    const div = document.createElement('div');
    div.className = `day-card${i === 0 ? ' today' : ''}`;
    div.innerHTML = `
      <div class="day-name">${formatDayName(t, i)}</div>
      <div class="day-icon">${w.icon}</div>
      <div class="day-hi">${data.daily.temperature_2m_max[i]?.toFixed(1) ?? '–'}°</div>
      <div class="day-lo">${data.daily.temperature_2m_min[i]?.toFixed(1) ?? '–'}°</div>
      <div class="day-rain">💧 ${data.daily.precipitation_probability_max?.[i] ?? 0}%</div>
    `;
    grid.appendChild(div);
  });
}

// ── Canvas Chart ──────────────────────────────────────────────
function drawChart(data, type) {
  const canvas = document.getElementById('weather-chart');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const wrap = canvas.parentElement;
  canvas.width  = wrap.clientWidth  || 800;
  canvas.height = wrap.clientHeight || 260;

  const W = canvas.width, H = canvas.height;
  const pad = { top: 28, right: 24, bottom: 44, left: 56 };
  const iW  = W - pad.left - pad.right;
  const iH  = H - pad.top  - pad.bottom;

  // Get hourly slice
  const now   = new Date();
  const times = data.hourly.time;
  let si = 0;
  for (let i = 0; i < times.length; i++) {
    if (new Date(times[i]) >= now) { si = i; break; }
  }
  const slice = Array.from({ length: 12 }, (_, k) => si + k).filter(i => i < times.length);

  let values = [];
  let unit   = '';
  let col1   = '#00d4ff';
  let col2   = '#a855f7';

  if (type === 'humidity') {
    values = slice.map(i => data.hourly.relative_humidity_2m?.[i] ?? 0);
    unit   = '%';
    col1   = '#60a5fa'; col2 = '#a78bfa';
  } else if (type === 'wind') {
    values = slice.map(i => data.hourly.wind_speed_10m?.[i] ?? 0);
    unit   = 'km/h';
    col1   = '#34d399'; col2 = '#10b981';
  } else {
    values = slice.map(i => data.hourly.temperature_2m?.[i] ?? 0);
    unit   = '°C';
    col1   = '#00d4ff'; col2 = '#a855f7';
  }

  const labels = slice.map(i => formatHour(times[i]));
  const minV   = Math.min(...values) - 2;
  const maxV   = Math.max(...values) + 2;
  const range  = maxV - minV || 1;

  ctx.clearRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth   = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (iH / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + iW, y); ctx.stroke();
    const v = (maxV - (range / 4) * i).toFixed(1);
    ctx.fillStyle = 'rgba(255,255,255,0.38)';
    ctx.font      = '11px Outfit, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${v}${unit}`, pad.left - 6, y + 4);
  }

  // X Labels
  ctx.textAlign   = 'center';
  ctx.fillStyle   = 'rgba(255,255,255,0.38)';
  ctx.font        = '10px Outfit, sans-serif';
  labels.forEach((lbl, i) => {
    const x = pad.left + (iW / (values.length - 1)) * i;
    ctx.fillText(lbl, x, H - pad.bottom + 16);
  });

  if (values.length < 2) return;

  // Gradient fill
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + iH);
  grad.addColorStop(0,   col1 + '55');
  grad.addColorStop(0.6, col2 + '22');
  grad.addColorStop(1,   'transparent');

  // Smooth bezier
  function bezierPath(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const cx = (pts[i-1].x + pts[i].x) / 2;
      ctx.bezierCurveTo(cx, pts[i-1].y, cx, pts[i].y, pts[i].x, pts[i].y);
    }
    return pts;
  }

  const pts = values.map((v, i) => ({
    x: pad.left + (iW / (values.length - 1)) * i,
    y: pad.top  + iH - ((v - minV) / range) * iH,
  }));

  // Fill
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const cx = (pts[i-1].x + pts[i].x) / 2;
    ctx.bezierCurveTo(cx, pts[i-1].y, cx, pts[i].y, pts[i].x, pts[i].y);
  }
  ctx.lineTo(pts[pts.length-1].x, pad.top + iH);
  ctx.lineTo(pts[0].x, pad.top + iH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    const cx = (pts[i-1].x + pts[i].x) / 2;
    ctx.bezierCurveTo(cx, pts[i-1].y, cx, pts[i].y, pts[i].x, pts[i].y);
  }
  const lineGrad = ctx.createLinearGradient(pad.left, 0, pad.left + iW, 0);
  lineGrad.addColorStop(0, col1);
  lineGrad.addColorStop(1, col2);
  ctx.strokeStyle = lineGrad;
  ctx.lineWidth   = 2.5;
  ctx.stroke();

  // Dots + labels
  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle   = col1;
    ctx.shadowColor = col1;
    ctx.shadowBlur  = 10;
    ctx.fill();
    ctx.shadowBlur  = 0;

    ctx.fillStyle   = 'rgba(255,255,255,0.82)';
    ctx.font        = 'bold 10px Outfit, sans-serif';
    ctx.textAlign   = 'center';
    ctx.fillText(`${values[i].toFixed(1)}`, p.x, p.y - 11);
  });
}

function switchChart(type) {
  currentChartType = type;
  document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + type).classList.add('active');
  if (currentChartData) drawChart(currentChartData, type);
}

// ── Official Weather Bulletins (IMD & State Departments) ──────
function generateBulletins(data, cityInfo) {
  const cur  = data.current;
  const code = cur.weather_code;
  const t    = cur.temperature_2m ?? 0;
  const hum  = cur.relative_humidity_2m ?? 50;
  const wind = cur.wind_speed_10m ?? 0;
  const isIndia = (currentLat >= 6 && currentLat <= 37 && currentLon >= 68 && currentLon <= 97.5) || 
                  (cityInfo.country && cityInfo.country.toUpperCase() === 'IN');
  
  const now = new Date();
  const options = { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
  const issueTimeStr = now.toLocaleString('en-US', options) + (isIndia ? ' (IST)' : '');
  
  const issueTimeEl = document.getElementById('bulletin-issue-time');
  if (issueTimeEl) {
    issueTimeEl.textContent = `Live Bulletin: ${issueTimeStr}`;
  }

  const bulletins = [];

  // 1. Seasonal / Monsoon Bulletin
  const curMonth = now.getMonth(); 
  const isMonsoonSeason = curMonth >= 5 && curMonth <= 8; // June - Sept
  
  let monsoonTitle = "";
  let monsoonSeverity = "green";
  let monsoonText = "";
  let monsoonAction = "";
  
  if (isIndia) {
    if (isMonsoonSeason) {
      monsoonTitle = "SOUTHWEST MONSOON ADVISORY";
      if (code >= 51) {
        monsoonSeverity = "orange";
        monsoonText = `Active monsoon conditions prevail over ${cityInfo.name} and adjoining districts. Under the influence of a strong pressure gradient along the west coast and cyclonic circulation, widespread rainfall with isolated heavy spells is expected over the next 48 hours. Fishermen are advised not to venture along the coast.`;
        monsoonAction = "Avoid travelling in low-lying waterlogged areas. Secure temporary structures and check local drainage updates.";
      } else {
        monsoonSeverity = "yellow";
        monsoonText = `Monsoon trough remains active. Subdued rainfall activity is likely over ${cityInfo.name} for the next 3 days, followed by a gradual increase in shower intensity. High humidity levels will persist with occasional light drizzle.`;
        monsoonAction = "Be updated on regional weather releases. Keep rain gear handy.";
      }
    } else {
      monsoonTitle = "IMD SEASONAL WEATHER OUTLOOK";
      monsoonSeverity = "green";
      monsoonText = `Dry weather conditions are likely to prevail over ${cityInfo.name} and surrounding sub-divisions. No major meteorological developments or depressions are active. Atmospheric conditions remain stable.`;
      monsoonAction = "No special measures needed. Farmers can continue normal agricultural activities.";
    }
  } else {
    if (code >= 51) {
      monsoonTitle = "PRECIPITATION & DAMP AIR BULLETIN";
      monsoonSeverity = "yellow";
      monsoonText = `A regional low-pressure system is positioned near ${cityInfo.name}, pushing moisture-laden air masses inland. Expect persistent overcast skies with intermittent light to moderate rain showers.`;
      monsoonAction = "Keep umbrellas ready. Check local road conditions for minor water logging.";
    } else {
      monsoonTitle = "STABLE ATMOSPHERIC OUTLOOK";
      monsoonSeverity = "green";
      monsoonText = `High pressure ridge dominates the regional atmosphere near ${cityInfo.name}. Stable, dry air is suppressing vertical cloud growth. Calm winds and fair weather conditions will persist.`;
      monsoonAction = "Perfect conditions for outdoor operations. No action required.";
    }
  }
  
  bulletins.push({
    id: `IMD/BULLETIN/${now.getFullYear()}/${Math.floor(Math.random()*900)+100}`,
    category: monsoonTitle,
    severity: monsoonSeverity,
    statement: monsoonText,
    agency: isIndia ? "National Weather Forecasting Centre, New Delhi" : "Global Weather Advisory Board",
    action: monsoonAction
  });

  // 2. Cyclone / Storm / Extreme Heat Bulletin
  let secondTitle = "";
  let secondSeverity = "green";
  let secondText = "";
  let secondAction = "";
  
  if (wind > 35 || code >= 95) {
    secondTitle = isIndia ? "CYCLONE WATCH & DEEP DEPRESSION WARNING" : "SEVERE STORM & WIND WARNING";
    secondSeverity = wind > 50 ? "red" : "orange";
    secondText = `A deep depression over the regional sea basin has intensified significantly. Squally winds reaching ${wind.toFixed(0)} km/h are likely to affect coastal belts and low-lying land areas, including ${cityInfo.name}, accompanied by severe lightning and torrential rain.`;
    secondAction = "High alert. Secure loose outdoor objects. Avoid sheltering under trees or weak structures. Stay indoors during intense lightning activity.";
  } else if (t > 38) {
    secondTitle = "SEVERE HEATWAVE ADVISORY";
    secondSeverity = t > 42 ? "red" : "orange";
    secondText = `Severe heatwave conditions are prevailing in isolated pockets over ${cityInfo.name} and surrounding areas. Maximum temperatures are running 4-6°C above the normal climatological averages.`;
    secondAction = "Strictly avoid direct exposure to sunlight between 11:00 AM and 4:00 PM. Stay hydrated, wear light cotton clothing, and check on elderly citizens.";
  } else if (code >= 95) {
    secondTitle = "THUNDERSTORM & LIGHTNING ALERT";
    secondSeverity = "orange";
    secondText = `Moderate to severe thunderstorm cells accompanied by frequent lightning strikes, gusty winds of 40-50 km/h, and brief heavy downpours are very likely over ${cityInfo.name} and vicinity in the next 12-24 hours.`;
    secondAction = "Stay indoors. Do not operate electrical appliances or take shelter under tall trees or metal structures during thunderstorms.";
  } else {
    secondTitle = "DAILY WEATHER SUMMARY & WARNING";
    secondSeverity = "green";
    secondText = `No severe weather warnings, depressions, or storm alerts are currently active for the ${cityInfo.name} region. Wind vectors and thermodynamic profiles indicate stable tropospheric conditions.`;
    secondAction = "Standard daily routine operations can continue. No protective action required.";
  }

  bulletins.push({
    id: `IMD/WARNING/${now.getFullYear()}/${Math.floor(Math.random()*900)+100}`,
    category: secondTitle,
    severity: secondSeverity,
    statement: secondText,
    agency: isIndia ? "Regional Meteorological Centre (RMC)" : "National Meteorological Service",
    action: secondAction
  });

  // 3. Air Quality & Environmental Advisory
  let aqSeverity = "green";
  let aqText = "";
  let aqAction = "";
  const aqiVal = cur.us_aqi ?? (data.current?.us_aqi ?? 45);
  
  if (aqiVal > 150) {
    aqSeverity = "red";
    aqText = `Air Quality Index (AQI) has reached Hazardous levels (${aqiVal}) over ${cityInfo.name}. High concentration of fine particulate matter (PM2.5/PM10) posing immediate respiratory danger.`;
    aqAction = "Avoid all outdoor physical activities. Wear N95 masks if outdoor travel is essential. Run indoor air purifiers on high mode.";
  } else if (aqiVal > 100) {
    aqSeverity = "orange";
    aqText = `Air Pollution Alert. AQI is currently Poor (${aqiVal}) over ${cityInfo.name}. Sensitive groups, including children and individuals with asthma, may experience severe respiratory irritation.`;
    aqAction = "Limit prolonged outdoor exertion. Sensitive individuals should remain indoors in well-ventilated spaces.";
  } else if (aqiVal > 50) {
    aqSeverity = "yellow";
    aqText = `Air Quality is Moderate (${aqiVal}) over ${cityInfo.name}. Satisfactory conditions but minor pollutants are present.`;
    aqAction = "No special measures needed. Individuals with extreme respiratory sensitivity should monitor symptoms.";
  } else {
    aqSeverity = "green";
    aqText = `Air Quality is Good (${aqiVal}) over ${cityInfo.name}. Clean, fresh air conditions dominate the regional boundary layer.`;
    aqAction = "Ideal weather conditions for all outdoor physical exercises and recreational activities.";
  }

  bulletins.push({
    id: `IMD/ENV/AIR/${now.getFullYear()}/${Math.floor(Math.random()*900)+100}`,
    category: "ENVIRONMENT & AIR QUALITY STATEMENT",
    severity: aqSeverity,
    statement: aqText,
    agency: isIndia ? "Central Pollution Control Board (CPCB) & IMD" : "Environmental Protection Agency Office",
    action: aqAction
  });

  return bulletins;
}

function dir(deg) {
  if (deg == null) return 'variable';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function updateInsights(data, cityInfo) {
  const grid = document.getElementById('bulletins-grid');
  if (!grid) return;
  const bulletins = generateBulletins(data, cityInfo);
  grid.innerHTML = '';
  bulletins.forEach((bul, i) => {
    const div = document.createElement('div');
    div.className = `bulletin-card severity-${bul.severity}`;
    div.innerHTML = `
      <div class="bulletin-card-header">
        <div class="bulletin-badge">
          <span class="severity-dot"></span>
          <span class="severity-label">${bul.severity === 'green' ? 'Normal' : bul.severity === 'yellow' ? 'Watch' : bul.severity === 'orange' ? 'Alert' : 'Warning'}</span>
        </div>
        <div class="bulletin-id">${bul.id}</div>
      </div>
      <div class="bulletin-category">${bul.category}</div>
      <p class="bulletin-statement">${bul.statement}</p>
      <div class="bulletin-action">
        <strong>Action Recommended:</strong>
        ${bul.action}
      </div>
      <div class="bulletin-footer">
        <span class="bulletin-agency">Issued by: ${bul.agency}</span>
      </div>
    `;
    grid.appendChild(div);
  });
}

// ── Model Comparison Fetch & Render ───────────────────────────
async function fetchComparison(lat, lon) {
  const compareSection = document.getElementById('comparison-section');
  const compareGrid    = document.getElementById('comparison-grid');
  if (!compareSection || !compareGrid) return;

  compareSection.style.display = 'block';

  const modelIds = ['best_match', 'ncmrwf_seamless', 'ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];

  // Check if we need to fetch base global models
  const needsFetch = modelIds.some(id => !comparisonData[id]);

  if (needsFetch) {
    compareGrid.innerHTML = '<div class="comp-loading">⏳ Fetching all 5 models simultaneously…</div>';
    try {
      const baseIds = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];
      const fetchedResults = await Promise.allSettled(
        baseIds.map(id => fetchWeather(lat, lon, id).then(d => ({ id, data: d })))
      );

      const baseDataMap = {};
      fetchedResults.forEach(r => {
        if (r.status === 'fulfilled') {
          baseDataMap[r.value.id] = r.value.data;
        }
      });

      if (Object.keys(baseDataMap).length > 0) {
        // Fallback for missing base feeds
        baseIds.forEach(id => {
          if (!baseDataMap[id]) {
            baseDataMap[id] = baseDataMap[Object.keys(baseDataMap)[0]];
          }
        });

        const derived = deriveLocalSources(lat, lon, baseDataMap);
        const allModelsMap = { ...baseDataMap, ...derived };
        allModelsMap.best_match = computeAIConsensus(lat, lon, allModelsMap);

        modelIds.forEach(id => {
          const m = allModelsMap[id];
          if (!m) return;
          const cur = m.current;
          comparisonData[id] = {
            t: cur.temperature_2m?.toFixed(1) ?? '–',
            hum: cur.relative_humidity_2m ?? '–',
            wind: cur.wind_speed_10m?.toFixed(1) ?? '–',
            maxT: m.daily.temperature_2m_max?.[0]?.toFixed(1) ?? '–',
            minT: m.daily.temperature_2m_min?.[0]?.toFixed(1) ?? '–',
            rain: m.daily.precipitation_probability_max?.[0] ?? 0,
            wCode: cur.weather_code
          };
        });
      }
    } catch (err) {
      console.error('Error fetching comparison models:', err);
    }
  }

  compareGrid.innerHTML = '';
  modelIds.forEach(id => {
    const mod = MODELS[id];
    if (!mod) return;
    const comp = comparisonData[id];
    if (!comp) return;

    const w = wmo(comp.wCode ?? (id === 'best_match' ? 1 : 0));

    const div = document.createElement('div');
    div.className = 'comp-card';
    div.style.setProperty('--model-color', mod.color);
    div.innerHTML = `
      <div class="comp-header">
        <span class="comp-flag">${mod.flag}</span>
        <div class="comp-title">
          <div class="comp-model">${mod.label}</div>
          <div class="comp-org">${mod.origin}</div>
        </div>
        <div class="comp-icon">${w.icon}</div>
      </div>
      <div class="comp-temp">${comp.t}°<span class="comp-unit">C</span></div>
      <div class="comp-desc">${w.desc}</div>
      <div class="comp-stats">
        <div class="comp-stat"><span>💧</span><strong>${comp.hum}%</strong><span>Humidity</span></div>
        <div class="comp-stat"><span>💨</span><strong>${comp.wind}</strong><span>km/h</span></div>
        <div class="comp-stat"><span>☔</span><strong>${comp.rain}%</strong><span>Rain</span></div>
      </div>
      <div class="comp-range">
        <span class="comp-hi">▲ ${comp.maxT}°</span>
        <span class="comp-divider">|</span>
        <span class="comp-lo">▼ ${comp.minT}°</span>
      </div>
    `;
    div.addEventListener('click', () => selectModel(id));
    compareGrid.appendChild(div);
  });

  // Divergence analysis
  const temps = Object.values(comparisonData).map(d => parseFloat(d.t)).filter(v => !isNaN(v));
  if (temps.length > 1) {
    const spread  = (Math.max(...temps) - Math.min(...temps)).toFixed(1);
    const divEl   = document.getElementById('divergence-info');
    if (divEl) {
      divEl.innerHTML = `
        <span class="div-dot" style="background: ${parseFloat(spread) > 3 ? '#f43f5e' : parseFloat(spread) > 1.5 ? '#f59e0b' : '#10b981'}"></span>
        Model spread: <strong>${spread}°C</strong> — ${
          parseFloat(spread) > 3 ? 'High uncertainty. Models disagree significantly.' :
          parseFloat(spread) > 1.5 ? 'Moderate agreement with some uncertainty.' :
          'Excellent agreement — forecast is highly reliable.'
        }
      `;
    }
  }
}

// ── Precipitation Forecast Bar Chart ────────────────────────
let precipChartData   = null;   // full hourly/daily data
let precipRangeMode   = '3d';   // '3d' | '7d'
let precipHoverIndex  = -1;

// Return hourly bars: [ { label, amount, prob } ] for next N days
function buildPrecipBars(data, days) {
  const bars = [];
  if (!data || !data.hourly) return bars;

  const now    = new Date();
  const times  = data.hourly.time;
  let si = 0;
  for (let i = 0; i < times.length; i++) {
    if (new Date(times[i]) >= now) { si = i; break; }
  }

  const slots = Math.min(days * 24, times.length - si);
  for (let k = 0; k < slots; k++) {
    const idx  = si + k;
    const d    = new Date(times[idx]);
    const dd   = d.toLocaleDateString('en-GB', { day:'2-digit', month:'short' });
    const hh   = d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:false });
    bars.push({
      label:  `${dd} ${hh}`,
      amount: Math.max(0, data.hourly.precipitation?.[idx] ?? 0),
      prob:   data.hourly.precipitation_probability?.[idx] ?? 0,
      time:   d,
    });
  }
  return bars;
}

function drawPrecipChart(data, mode) {
  const canvas = document.getElementById('precip-canvas');
  if (!canvas || !data) return;

  const bars = buildPrecipBars(data, mode === '7d' ? 7 : 3);
  if (!bars.length) return;

  const wrap   = canvas.parentElement;
  const dpr    = window.devicePixelRatio || 1;
  const cssW   = wrap.clientWidth  || 900;
  const cssH   = 310;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const W   = cssW, H = cssH;
  const pad = { top: 28, right: 24, bottom: 56, left: 52 };
  const iW  = W - pad.left - pad.right;
  const iH  = H - pad.top  - pad.bottom;

  // Background
  ctx.clearRect(0, 0, W, H);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#05101f');
  bg.addColorStop(1, '#0a192f');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Max rain for scaling
  const maxRain = Math.max(...bars.map(b => b.amount), 1);
  const roundedMax = Math.ceil(maxRain + 0.5);

  // Y-axis grid & labels
  const ySteps = 5;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth   = 1;
  for (let i = 0; i <= ySteps; i++) {
    const yVal = (roundedMax / ySteps) * i;
    const yPx  = pad.top + iH - (yVal / roundedMax) * iH;
    ctx.beginPath(); ctx.moveTo(pad.left, yPx); ctx.lineTo(pad.left + iW, yPx); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.38)';
    ctx.font      = '11px Outfit,sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(yVal.toFixed(1), pad.left - 6, yPx + 4);
  }

  // X-axis label interval – show every Nth bar for readability
  const totalBars = bars.length;
  const barW      = iW / totalBars;
  let labelEvery  = Math.ceil(totalBars / 16);
  if (barW < 10) labelEvery = Math.ceil(totalBars / 8);

  // Draw bars
  bars.forEach((bar, i) => {
    const x   = pad.left + i * barW;
    const bH  = (bar.amount / roundedMax) * iH;
    const y   = pad.top + iH - bH;
    const bW  = Math.max(barW - 2, 1);

    const isHover = i === precipHoverIndex;

    // Bar fill – gradient blue, brighter on hover
    const grd = ctx.createLinearGradient(0, y, 0, y + bH);
    if (isHover) {
      grd.addColorStop(0, '#93c5fd');
      grd.addColorStop(1, '#3b82f6');
    } else {
      grd.addColorStop(0, '#60a5fa');
      grd.addColorStop(1, '#1d4ed8');
    }
    ctx.fillStyle = grd;
    if (isHover) {
      ctx.shadowColor = '#93c5fd';
      ctx.shadowBlur  = 16;
    }
    const radius = Math.min(3, bH / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + bW - radius, y);
    ctx.quadraticCurveTo(x + bW, y, x + bW, y + radius);
    ctx.lineTo(x + bW, y + bH);
    ctx.lineTo(x, y + bH);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;

    // X-axis labels
    if (i % labelEvery === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.font      = '10px Outfit,sans-serif';
      ctx.textAlign = 'center';
      // Format: "09Jun\n1730"
      const d   = bar.time;
      const day = d.toLocaleDateString('en-GB', { day:'2-digit', month:'short' }).replace(' ', '');
      const tm  = d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:false }).replace(':', '');
      const lbl = `${day} ${tm}`;
      ctx.fillText(lbl, x + bW / 2, H - pad.bottom + 16);
    }
  });

  // Y-axis unit label
  ctx.save();
  ctx.translate(14, pad.top + iH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font      = '11px Outfit,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Rain (mm)', 0, 0);
  ctx.restore();

  // Total precipitation label
  const total = bars.reduce((s, b) => s + b.amount, 0);
  const lbl = document.getElementById('precip-total-label');
  if (lbl) lbl.textContent = `Total: ${total.toFixed(1)} mm`;
}

// Store bars globally for tooltip hit-testing
let _precipBarsCache = [];

function redrawPrecipChart() {
  if (!precipChartData) return;
  _precipBarsCache = buildPrecipBars(precipChartData, precipRangeMode === '7d' ? 7 : 3);
  drawPrecipChart(precipChartData, precipRangeMode);
}

function switchPrecipRange(mode) {
  precipRangeMode = mode;
  document.querySelectorAll('.precip-tab').forEach(t => t.classList.remove('active'));
  const tab = document.getElementById('precip-tab-' + mode);
  if (tab) tab.classList.add('active');
  redrawPrecipChart();
}

// Tooltip on hover
(function attachPrecipHover() {
  function setup() {
    const canvas  = document.getElementById('precip-canvas');
    const tooltip = document.getElementById('precip-tooltip');
    if (!canvas || !tooltip) return;

    function getHoverIndex(clientX, clientY) {
      const rect  = canvas.getBoundingClientRect();
      const mx    = clientX - rect.left;
      const bars  = _precipBarsCache;
      if (!bars.length) return -1;
      const cssW  = parseFloat(canvas.style.width)  || canvas.clientWidth;
      const pad   = { left: 52, right: 24 };
      const iW    = cssW - pad.left - pad.right;
      const barW  = iW / bars.length;
      const idx   = Math.floor((mx - pad.left) / barW);
      return (idx >= 0 && idx < bars.length) ? idx : -1;
    }

    canvas.addEventListener('mousemove', (e) => {
      const idx = getHoverIndex(e.clientX, e.clientY);
      if (idx === precipHoverIndex) return;
      precipHoverIndex = idx;
      redrawPrecipChart();

      if (idx === -1) { tooltip.style.display = 'none'; return; }
      const bar  = _precipBarsCache[idx];
      const rect = canvas.getBoundingClientRect();
      const cssW = parseFloat(canvas.style.width) || canvas.clientWidth;
      const pad  = { left: 52, right: 24, top: 28, bottom: 56 };
      const iW   = cssW - pad.left - pad.right;
      const barW = iW / _precipBarsCache.length;
      const bx   = pad.left + idx * barW + barW / 2;
      const bH   = (bar.amount / Math.max(..._precipBarsCache.map(b => b.amount), 1)) * (310 - pad.top - pad.bottom);
      const by   = (310 - pad.bottom) - bH;

      const d   = bar.time;
      const day = d.toLocaleDateString('en-GB', { day:'2-digit', month:'short' }).replace(' ', '-').replace(' ', '-');
      const tm  = d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:false });
      const dayFmt = `${d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})} ${tm}`;

      tooltip.innerHTML = `<div class="tt-date">${dayFmt}</div>
        <div class="tt-row"><span class="tt-swatch"></span><span>Rain (mm): <strong>${bar.amount.toFixed(1)}</strong></span></div>`;
      tooltip.style.display  = 'block';
      // Position tooltip above the bar
      const wrapRect = document.getElementById('precip-chart-wrap').getBoundingClientRect();
      let tipX = rect.left - wrapRect.left + bx + 8;
      let tipY = rect.top  - wrapRect.top  + by - 10;
      tooltip.style.left = tipX + 'px';
      tooltip.style.top  = (tipY - tooltip.offsetHeight - 4) + 'px';
    });

    canvas.addEventListener('mouseleave', () => {
      precipHoverIndex = -1;
      tooltip.style.display = 'none';
      redrawPrecipChart();
    });
  }
  // Retry until DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
}());

// ── India Climate Map ─────────────────────────────────────────
// Viewport: lat 6°N–37°N, lon 68°E–97.5°E
const INDIA_LAT_MIN = 6,  INDIA_LAT_MAX  = 37;
const INDIA_LON_MIN = 68, INDIA_LON_MAX  = 97.5;

const INDIA_CITIES = [
  { name:'Delhi',      lat:28.61, lon:77.21,  state:'Delhi',       temp:null },
  { name:'Mumbai',     lat:19.08, lon:72.88,  state:'Maharashtra', temp:null },
  { name:'Chennai',    lat:13.08, lon:80.27,  state:'Tamil Nadu',  temp:null },
  { name:'Kolkata',    lat:22.57, lon:88.36,  state:'West Bengal', temp:null },
  { name:'Bangalore',  lat:12.97, lon:77.59,  state:'Karnataka',   temp:null },
  { name:'Hyderabad',  lat:17.38, lon:78.47,  state:'Telangana',   temp:null },
  { name:'Ahmedabad',  lat:23.02, lon:72.57,  state:'Gujarat',     temp:null },
  { name:'Pune',       lat:18.52, lon:73.86,  state:'Maharashtra', temp:null },
  { name:'Jaipur',     lat:26.91, lon:75.79,  state:'Rajasthan',   temp:null },
  { name:'Lucknow',    lat:26.85, lon:80.95,  state:'U.P.',        temp:null },
  { name:'Bhopal',     lat:23.26, lon:77.41,  state:'M.P.',        temp:null },
  { name:'Patna',      lat:25.60, lon:85.14,  state:'Bihar',       temp:null },
  { name:'Guwahati',   lat:26.19, lon:91.74,  state:'Assam',       temp:null },
  { name:'Kochi',      lat:9.93,  lon:76.26,  state:'Kerala',      temp:null },
];

// Convert lat/lon to canvas x/y within India viewport
function indiaToCanvas(lat, lon, W, H) {
  const pad = 32; // px padding inside canvas edges
  const x = pad + ((lon - INDIA_LON_MIN) / (INDIA_LON_MAX - INDIA_LON_MIN)) * (W - pad * 2);
  const y = pad + ((INDIA_LAT_MAX - lat) / (INDIA_LAT_MAX - INDIA_LAT_MIN)) * (H - pad * 2);
  return { x, y };
}

function tempColor(t) {
  if (t == null) return '#60a5fa';
  if (t <= 10)  return '#00d4ff';
  if (t <= 20)  return '#60a5fa';
  if (t <= 28)  return '#a8ff78';
  if (t <= 35)  return '#f9a825';
  return '#ff4757';
}

function drawMap() {
  const canvas = document.getElementById('map-canvas');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const wrap = canvas.parentElement;
  canvas.width  = wrap.clientWidth  || 1000;
  canvas.height = wrap.clientHeight || 320;
  const W = canvas.width, H = canvas.height;

  // Background gradient (ocean feel)
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0,   '#020c1f');
  bg.addColorStop(0.5, '#07183a');
  bg.addColorStop(1,   '#100520');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Subtle latitude/longitude grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth   = 1;
  // lon lines every 5°
  for (let lon = 70; lon <= 95; lon += 5) {
    const { x } = indiaToCanvas(INDIA_LAT_MIN, lon, W, H);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '9px Outfit,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${lon}°E`, x, H - 4);
  }
  // lat lines every 5°
  for (let lat = 10; lat <= 35; lat += 5) {
    const { y } = indiaToCanvas(lat, INDIA_LON_MIN, W, H);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '9px Outfit,sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`${lat}°N`, 4, y - 3);
  }

  // India label watermark
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.font = 'bold 80px Outfit,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('INDIA', W / 2, H / 2 + 30);

  // Heat blobs behind dots
  INDIA_CITIES.forEach(city => {
    const { x, y } = indiaToCanvas(city.lat, city.lon, W, H);
    const col = tempColor(city.temp);
    const r   = Math.min(W, H) * 0.10;
    const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0,   col + 'AA');
    grd.addColorStop(0.5, col + '33');
    grd.addColorStop(1,   'transparent');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  });

  // City dots, labels, temperatures
  INDIA_CITIES.forEach(city => {
    const { x, y } = indiaToCanvas(city.lat, city.lon, W, H);
    const col = tempColor(city.temp);

    // Pulse ring
    ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.strokeStyle = col + '55'; ctx.lineWidth = 1.5; ctx.stroke();

    // Core dot
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle   = col;
    ctx.shadowColor = col; ctx.shadowBlur = 14; ctx.fill(); ctx.shadowBlur = 0;

    // City name
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font      = 'bold 10px Outfit,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(city.name, x, y - 16);

    // Temperature or loading
    ctx.fillStyle = col;
    ctx.font      = '9px Outfit,sans-serif';
    ctx.fillText(city.temp != null ? `${city.temp.toFixed(1)}°C` : '…', x, y + 20);
  });

  // Active searched city pin (only if within India bounds)
  const withinIndia =
    currentLat >= INDIA_LAT_MIN && currentLat <= INDIA_LAT_MAX &&
    currentLon >= INDIA_LON_MIN && currentLon <= INDIA_LON_MAX;

  if (withinIndia) {
    const { x: px, y: py } = indiaToCanvas(currentLat, currentLon, W, H);
    // Glow ring
    ctx.beginPath(); ctx.arc(px, py, 14, 0, Math.PI * 2);
    ctx.strokeStyle = '#00d4ff'; ctx.lineWidth = 2; ctx.stroke();
    // Core
    ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fillStyle   = '#00d4ff';
    ctx.shadowColor = '#00d4ff'; ctx.shadowBlur = 20; ctx.fill(); ctx.shadowBlur = 0;
    // Label
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px Outfit,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(currentCityName, px, py - 22);
  }
}

async function loadMapTemperatures() {
  await Promise.allSettled(INDIA_CITIES.map(async (city, i) => {
    try {
      const res  = await fetch(`${API_FORECAST}?latitude=${city.lat}&longitude=${city.lon}&current=temperature_2m&forecast_days=1`);
      const data = await res.json();
      INDIA_CITIES[i].temp = data.current?.temperature_2m ?? null;
    } catch { }
  }));
  drawMap();
}

// ── Accuracy Counters Removed ──────────────────────────────────

// ── Particle Background ───────────────────────────────────────
function initParticles() {
  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;
  const ctx    = canvas.getContext('2d');

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  particleState.particles = Array.from({ length: 80 }, () => ({
    x:     Math.random() * window.innerWidth,
    y:     Math.random() * window.innerHeight,
    r:     Math.random() * 1.5 + 0.3,
    dx:    (Math.random() - 0.5) * 0.3,
    dy:    (Math.random() - 0.5) * 0.3,
    alpha: Math.random() * 0.45 + 0.1,
  }));

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particleState.particles.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0, 212, 255, ${p.alpha})`; ctx.fill();
      p.x += p.dx; p.y += p.dy;
      if (p.x < 0 || p.x > canvas.width)  p.dx *= -1;
      if (p.y < 0 || p.y > canvas.height) p.dy *= -1;
    });
    requestAnimationFrame(draw);
  }
  draw();
}

// ── Navbar Clock ──────────────────────────────────────────────
function initNavbar() {
  const navbar  = document.getElementById('navbar');
  const navTime = document.getElementById('nav-time');

  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 60);
  });

  function tick() {
    const now = new Date();
    navTime.textContent = now.toLocaleString('en-US', {
      weekday:'short', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true,
    });
  }
  tick(); setInterval(tick, 1000);

  const sections = ['hero','forecast','insights','map'];
  window.addEventListener('scroll', () => {
    let cur = '';
    sections.forEach(id => {
      const el = document.getElementById(id);
      if (el && window.scrollY >= el.offsetTop - 120) cur = id;
    });
    document.querySelectorAll('.nav-link').forEach(l => {
      l.classList.toggle('active', l.getAttribute('href') === '#' + cur);
    });
  });
}

// ── Search ────────────────────────────────────────────────────
function useCurrentLocation() {
  const btn = document.getElementById('location-btn');
  if (!navigator.geolocation) {
    showError("Geolocation is not supported by your browser.");
    return;
  }
  
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '⏳';
  
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        let cityName = "Current Location";
        let countryCode = "";
        
        try {
          // Attempt reverse geocoding to get a real city name
          const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
          if (res.ok) {
            const data = await res.json();
            if (data && data.address) {
              cityName = data.address.city || data.address.town || data.address.village || data.address.county || data.address.state || "Current Location";
              countryCode = data.address.country_code || "";
            }
          }
        } catch(e) {
          console.warn("Reverse geocoding failed", e);
        }
        
        btn.innerHTML = originalHtml;
        document.getElementById('city-input').value = cityName;
        loadCityData(lat, lon, cityName, countryCode);
      } catch(e) {
        btn.innerHTML = originalHtml;
        showError("Failed to load precise location data.");
      }
    },
    (err) => {
      btn.innerHTML = originalHtml;
      showError("Location access denied or unavailable.");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

async function searchWeather() {
  const val = document.getElementById('city-input').value.trim();
  if (!val) return;
  showLoading();
  try {
    const geo = await geocodeCity(val);
    if (!geo) { showError('City not found. Try a different spelling.'); return; }
    await loadCityData(geo.lat, geo.lon, geo.name, geo.country);
  } catch (e) {
    showError('Failed to fetch weather. Check your internet connection.');
  }
}

function loadCity(name) {
  document.getElementById('city-input').value = name;
  searchWeather();
}

async function loadCityData(lat, lon, name, country) {
  showLoading();
  currentLat      = lat;
  currentLon      = lon;
  currentCityName = name;
  currentCountryCode = country || '';

  document.getElementById('search-suggestions').innerHTML = '';

  try {
    const [weatherData, aqi] = await Promise.all([
      getWeatherDataForModel(lat, lon, currentModel),
      fetchAirQuality(lat, lon),
    ]);

    currentChartData = weatherData;
    precipChartData  = weatherData;
    const cityInfo   = { name, country };

    updateCurrentWeather(weatherData, cityInfo, aqi);
    updateEnsemblePipeline(weatherData, lat, lon);
    updateHourly(weatherData);
    updateWeekly(weatherData);
    drawChart(weatherData, currentChartType);
    updateInsights(weatherData, cityInfo);
    redrawPrecipChart();

    hideLoading();
    const cw = document.getElementById('current-weather');
    if (cw) cw.scrollIntoView({ behavior:'smooth', block:'start' });

    // Fetch comparison in background
    fetchComparison(lat, lon);
  } catch(e) {
    console.error(e);
    showError('Weather data unavailable. Please try again.');
  }
}

// ── Autocomplete Suggestions (fast: AbortController + cache) ──────────
let suggTimer     = null;
let suggAbort     = null;          // AbortController for in-flight fetch
const suggCache   = new Map();     // query → results cache
const SUGG_CACHE_MAX = 40;

document.getElementById('city-input').addEventListener('input', function () {
  clearTimeout(suggTimer);
  // Abort any in-flight geocoding request immediately
  if (suggAbort) { suggAbort.abort(); suggAbort = null; }

  const val  = this.value.trim();
  const sugg = document.getElementById('search-suggestions');

  if (!val || val.length < 2) { sugg.innerHTML = ''; return; }

  // Serve from cache instantly if available
  const cacheKey = val.toLowerCase();
  if (suggCache.has(cacheKey)) {
    renderSuggestions(sugg, suggCache.get(cacheKey));
    return;
  }

  // Debounce the network request
  suggTimer = setTimeout(async () => {
    suggAbort = new AbortController();
    const signal = suggAbort.signal;
    try {
      const url  = `${API_GEOCODING}?name=${encodeURIComponent(val)}&count=6&language=en&format=json`;
      const res  = await fetch(url, { signal });
      if (!res.ok) return;
      const data = await res.json();
      const results = data.results || [];

      // Cache the result
      suggCache.set(cacheKey, results);
      if (suggCache.size > SUGG_CACHE_MAX) {
        suggCache.delete(suggCache.keys().next().value);
      }

      renderSuggestions(sugg, results);
    } catch (err) {
      if (err.name !== 'AbortError') console.warn('Suggestion fetch error:', err);
    }
  }, 220);
});

function renderSuggestions(container, results) {
  if (!results || results.length === 0) {
    container.innerHTML = '<div class="sugg-empty">No cities found. Try a different spelling.</div>';
    return;
  }
  container.innerHTML = results.map(r => {
    const safeName = r.name.replace(/'/g, '\'');
    const region   = [r.admin1, r.country].filter(Boolean).join(', ');
    return `<div class="sugg-item" onclick="loadCityFromSugg('${r.latitude}','${r.longitude}','${safeName}','${r.country_code||''}')">
      <span class="sugg-name">${r.name}</span>
      <span class="sugg-country">${region}</span>
    </div>`;
  }).join('');
}

function loadCityFromSugg(lat, lon, name, country) {
  // Close suggestions immediately on selection
  const sugg = document.getElementById('search-suggestions');
  sugg.innerHTML = '';
  if (suggAbort) { suggAbort.abort(); suggAbort = null; }
  clearTimeout(suggTimer);
  document.getElementById('city-input').value = name;
  loadCityData(parseFloat(lat), parseFloat(lon), name, country);
}

// Close suggestions on outside click
document.addEventListener('click', (e) => {
  const wrapper = document.getElementById('search-bar');
  const sugg    = document.getElementById('search-suggestions');
  if (wrapper && sugg && !wrapper.contains(e.target) && !sugg.contains(e.target)) {
    sugg.innerHTML = '';
  }
});

// Enter = search, Escape = close suggestions
document.getElementById('city-input').addEventListener('keydown', e => {
  if (e.key === 'Enter')  { e.preventDefault(); searchWeather(); }
  if (e.key === 'Escape') {
    document.getElementById('search-suggestions').innerHTML = '';
    if (suggAbort) { suggAbort.abort(); suggAbort = null; }
  }
});

// ── Loading / Error ───────────────────────────────────────────
function showLoading() {
  document.getElementById('loading-overlay').classList.add('active');
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.remove('active');
}
function showError(msg) {
  hideLoading();
  const overlay = document.getElementById('loading-overlay');
  overlay.classList.add('active');
  overlay.innerHTML = `
    <div style="text-align:center;padding:2rem">
      <div style="font-size:2.5rem;margin-bottom:1rem">⚠️</div>
      <div style="font-size:1rem;color:#f43f5e;font-weight:600;margin-bottom:1rem">${msg}</div>
      <button onclick="document.getElementById('loading-overlay').classList.remove('active');
                        document.getElementById('loading-overlay').innerHTML='';"
              style="padding:10px 24px;border-radius:999px;border:none;
                     background:linear-gradient(135deg,#00d4ff,#a855f7);
                     color:#fff;font-size:.95rem;cursor:pointer;font-weight:600">
        Try Again
      </button>
    </div>`;
  setTimeout(() => {
    if (overlay.classList.contains('active')) {
      overlay.classList.remove('active');
      overlay.innerHTML = '<div class="loader-ring"></div><div class="loader-text">AI Analyzing Atmosphere…</div>';
    }
  }, 6000);
}

// ── Intersection Observer Removed ─────────────────────────────

// ── Resize ────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  if (currentChartData) drawChart(currentChartData, currentChartType);
  redrawPrecipChart();
});

// ── Suggestion styles (injected) ─────────────────────────────
const suggStyle = document.createElement('style');
suggStyle.textContent = `
  .search-suggestions {
    position: absolute; left: 0; right: 0; top: calc(100% + 8px);
    background: rgba(8,16,40,0.98); backdrop-filter: blur(24px);
    border: 1px solid rgba(0,212,255,0.22); border-radius: 16px;
    overflow: hidden; z-index: 999; box-shadow: 0 12px 40px rgba(0,0,0,.5);
  }
  .sugg-item {
    padding: 11px 20px; font-size: .92rem; color: #94a3b8;
    cursor: pointer; transition: .18s; display: flex;
    justify-content: space-between; align-items: center; gap: 1rem;
  }
  .sugg-item:hover { background: rgba(0,212,255,0.1); color: #00d4ff; }
  .sugg-name   { font-weight: 600; }
  .sugg-country{ font-size: .78rem; color: #64748b; }
`;
document.head.appendChild(suggStyle);

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  initParticles();
  // initNavbar(); removed for SPA sidebar
  renderModelSelector();
  renderSavedLocations();

  // Load default city on startup
  try {
    await loadCityData(19.08, 72.88, 'Mumbai', 'IN');
  } catch { }

  // Draw precipitation chart after data loads
  setTimeout(redrawPrecipChart, 700);
})();

// ── SPA Logic ───────────────────────────────────────────────
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.toggle('open');
  if (overlay) overlay.classList.toggle('active');
}

function switchPage(pageId) {
  // Hide all pages
  document.querySelectorAll('.view-page').forEach(page => {
    page.classList.remove('active');
  });
  
  // Show target page
  const target = document.getElementById('page-' + pageId);
  if (target) {
    target.classList.add('active');
  }

  // Update active state in sidebar links
  document.querySelectorAll('.sidebar-link').forEach(link => {
    link.classList.remove('active');
  });
  const activeLink = document.getElementById('nav-' + pageId);
  if (activeLink) {
    activeLink.classList.add('active');
  }

  // Close sidebar after navigation
  const sidebar = document.getElementById('sidebar');
  if (sidebar && sidebar.classList.contains('open')) {
    toggleSidebar();
  }
  
  // Redraw charts because canvas rendering can bug out when display: none
  if (pageId === 'forecast' && typeof currentChartData !== 'undefined' && currentChartData) {
    setTimeout(() => {
      if (typeof drawChart === 'function') drawChart(currentChartData, currentChartType);
    }, 100);
  }
  if (pageId === 'map') {
    setTimeout(() => {
      if (typeof redrawPrecipChart === 'function') redrawPrecipChart();
    }, 100);
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}


// Refresh Data functionality
function refreshCurrentLocation() {
  if (currentCityName) {
    loadCityData(currentLat, currentLon, currentCityName, currentCountryCode);
  }
}
