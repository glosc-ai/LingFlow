import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'LingFlow',
  description: 'Seamless bilingual reading and translation assistant.',
  version: '0.0.2',
  action: {
    default_title: 'LingFlow',
    default_popup: 'index.html',
    default_icon: {
      16: 'icons/16.png',
      32: 'icons/32.png',
      48: 'icons/48.png',
      128: 'icons/128.png',
    },
  },
  icons: {
    16: 'icons/16.png',
    32: 'icons/32.png',
    48: 'icons/48.png',
    128: 'icons/128.png',
  },
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['activeTab', 'scripting', 'storage'],
  host_permissions: ['<all_urls>', 'http://127.0.0.1:47631/*', 'http://localhost:47631/*'],
});
