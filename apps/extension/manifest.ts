import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'LingFlow',
  description: 'Seamless bilingual reading and translation assistant.',
  version: '0.0.2',
  action: {
    default_title: 'LingFlow',
    default_popup: 'index.html',
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
  permissions: ['activeTab', 'contextMenus', 'scripting', 'storage'],
  host_permissions: ['<all_urls>', 'http://127.0.0.1:47631/*', 'http://localhost:47631/*'],
});
