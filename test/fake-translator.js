'use strict';

// Stand-in for the MyMemory translation API used by backend/translate.js in
// tests: GET /get?q=…&langpair=pt-BR|en-GB answers with a word-by-word swap
// from a tiny dictionary. Like the real service it turns "1.2" into "1,2"
// and drops the space before "<", so the repair step is exercised too.
// The query "quota" answers as if the daily limit were used up.

const express = require('express');

const PT_EN = { 'retrato': 'portrait', 'mulher': 'woman', 'fundo': 'background', 'vermelho': 'red', 'azul': 'blue', 'luz': 'light', 'camisa': 'shirt', 'de': 'of', 'suave': 'soft', 'foto': 'photo' };
const EN_PT = Object.fromEntries(Object.entries(PT_EN).map(([k, v]) => [v, k]));
const swap = (text, dict) => text.replace(/[A-Za-zÀ-ú]+/g, w => dict[w.toLowerCase()] || w);

const received = [];

function fakeTranslator() {
  const app = express();
  app.get('/get', (req, res) => {
    const q = String(req.query.q || '');
    const pair = String(req.query.langpair || '');
    received.push({ q, pair, email: req.query.de || '' });
    if (q === 'quota') return res.json({ responseData: { translatedText: '' }, quotaFinished: true, responseStatus: 429 });
    const dict = pair.startsWith('pt') ? PT_EN : EN_PT;
    const text = swap(q, dict).replace(/:(\d+)\.(\d+)/g, ':$1,$2').replace(/,\s+</g, ',<');
    res.json({ responseData: { translatedText: text, match: 1 }, quotaFinished: false, responseStatus: 200 });
  });
  return app;
}

module.exports = { fakeTranslator, received };
