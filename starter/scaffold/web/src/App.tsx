import { useEffect, useState } from 'react';

// Placeholder. It only proves the browser can reach your server through the
// Vite proxy. Replace it with the product.
export function App() {
  const [server, setServer] = useState('checking…');

  useEffect(() => {
    fetch('/healthz')
      .then((res) => (res.ok ? 'reachable' : `answered ${res.status}`))
      .catch(() => 'not reachable (is it running on :4000?)')
      .then(setServer);
  }, []);

  return (
    <main style={{ font: '16px system-ui', maxWidth: 560, margin: '80px auto' }}>
      <h1>Switchboard</h1>
      <p>Server: {server}</p>
    </main>
  );
}
