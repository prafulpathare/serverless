import { pathToFileURL } from 'url';

process.on('message', async (job) => {
  try {
    // Convert Windows path → file:// URL
    const fileUrl = pathToFileURL(job.functionPath).href;

    // Optional cache-busting (helpful during development)
    const mod = await import(fileUrl + `?t=${Date.now()}`);

    const handler = mod.handler || mod.default;

    if (typeof handler !== 'function') {
      throw new Error('No valid handler exported. Make sure you export `handler`');
    }

    const result = await handler(job.event, job.context);
    process.send({ result });
  } catch (err) {
    process.send({ error: err.message || String(err) });
  }
});