'use strict';

// Stand-ins for a ComfyUI server and a RunPod Serverless endpoint
// (worker-comfyui 5.x response shape), shared by the API and browser tests.

const express = require('express');
const sharp = require('sharp');

let png;
const ready = sharp({ create: { width: 64, height: 96, channels: 3, background: '#a33' } }).png().toBuffer().then(b => { png = b; });
const received = { prompts: [], uploads: 0, runpod: [], cancelled: [], uploaded: [] };

function fakeComfy() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  const done = new Map();
  const waiting = new Set();   // prompts ComfyUI still has queued or running
  app.get('/system_stats', (req, res) => res.json({ system: { comfyui_version: '0.3.test' } }));
  app.post('/upload/image', (req, res) => { received.uploads++; req.resume(); req.on('end', () => res.json({ name: 'in_' + received.uploads + '.png', subfolder: '', type: 'input' })); });
  app.get('/object_info/:cls', (req, res) => req.params.cls === 'ResolutionSelector'
    ? res.json({ ResolutionSelector: { input: { required: { aspect_ratio: [['1:1 (Square)', '2:3 (Portrait Photo)', '3:2 (Landscape Photo)', '9:16 (Vertical)', '16:9 (Widescreen)']] } } } })
    : req.params.cls === 'KSampler'
    ? res.json({ KSampler: { input: { required: { steps: ['INT', { min: 1, max: 100, step: 1 }], sampler_name: [['euler', 'dpmpp_2m', 'ddim']], cfg: ['FLOAT', { min: 0, max: 30, step: 0.1 }] } } } })
    : res.json({}));
  app.get('/queue', (req, res) => res.json({ queue_running: [...waiting].map((pid, i) => [i, pid, {}]), queue_pending: [] }));
  app.post('/queue', (req, res) => { for (const pid of req.body.delete || []) { received.cancelled.push(pid); waiting.delete(pid); } res.json({}); });
  app.post('/interrupt', (req, res) => res.json({}));
  app.post('/prompt', (req, res) => {
    const promptId = 'p' + received.prompts.length;
    received.prompts.push(req.body.prompt);
    const texts = Object.values(req.body.prompt).map(n => n.inputs && n.inputs.text);
    if (texts.includes('please vanish')) { /* accepted, then lost: not queued, never finishes */ }
    else if (texts.includes('please wait')) waiting.add(promptId);
    else { waiting.add(promptId); setTimeout(() => { done.set(promptId, true); waiting.delete(promptId); }, 30); }
    res.json({ prompt_id: promptId, node_errors: {} });
  });
  app.get('/history/:id', (req, res) => {
    if (!done.get(req.params.id)) return res.json({});
    const wf = received.prompts[Number(req.params.id.slice(1))] || {};
    const classes = Object.values(wf).map(n => n.class_type);
    if (classes.includes('PreviewImage') && !classes.includes('SaveImage')) {
      return res.json({ [req.params.id]: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] } } } });
    }
    res.json({ [req.params.id]: { status: { status_str: 'success', completed: true },
      outputs: { 9: { images: [{ filename: 'ComfyUI_0001_.png', subfolder: '', type: 'output' }, { filename: 'preview.png', subfolder: '', type: 'temp' }] } } } });
  });
  app.get('/view', (req, res) => res.type('png').send(png));
  return app;
}

function fakeRunpod() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  const jobs = new Map();
  app.use((req, res, next) => req.get('authorization') === 'Bearer rp-key' ? next() : res.status(401).json({ error: 'unauthorized' }));
  app.get('/v2/:endpoint/health', (req, res) => res.json({ workers: { idle: 2, running: 0 } }));
  app.post('/v2/:endpoint/run', (req, res) => {
    const jobId = 'rp' + jobs.size;
    received.runpod.push(req.body.input);
    const fail = req.body.input.workflow['6'].inputs.text === 'please fail';
    const slow = req.body.input.workflow['6'].inputs.text === 'please wait';
    jobs.set(jobId, { polls: 0, fail, slow });
    res.json({ id: jobId, status: 'IN_QUEUE' });
  });
  app.post('/v2/:endpoint/cancel/:id', (req, res) => { received.cancelled.push(req.params.id); res.json({ status: 'CANCELLED' }); });
  app.get('/v2/:endpoint/status/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (job.slow || ++job.polls < 2) return res.json({ id: req.params.id, status: 'IN_PROGRESS' });
    if (job.fail) return res.json({ id: req.params.id, status: 'FAILED', error: 'CUDA out of memory' });
    res.json({ id: req.params.id, status: 'COMPLETED', output: { images: [{ filename: 'ComfyUI_rp.png', type: 'base64', data: png.toString('base64') }] } });
  });
  return app;
}


module.exports = { fakeComfy, fakeRunpod, received, ready };
