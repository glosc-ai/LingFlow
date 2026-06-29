import { beforeEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { cleanupLingFlow, extractReadableSegments, injectBilingualText } from './index';

describe('@lingflow/dom', () => {
  beforeEach(() => {
    const window = new Window();
    globalThis.window = window as unknown as Window & typeof globalThis.window;
    globalThis.document = window.document as unknown as Document;
    globalThis.Element = window.Element as unknown as typeof Element;
    globalThis.HTMLElement = window.HTMLElement as unknown as typeof HTMLElement;
  });

  it('extracts readable paragraph segments and skips code/script content', () => {
    document.body.innerHTML = `
      <article>
        <p>This is a readable paragraph with enough text.</p>
        <pre>const secret = true</pre>
        <script>window.bad = true</script>
        <p>Short</p>
      </article>
    `;

    const segments = extractReadableSegments(document.body);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe('This is a readable paragraph with enough text.');
  });

  it('skips navigation and footer content when extracting page segments', () => {
    document.body.innerHTML = `
      <nav><ul><li>Pull requests</li><li>Security and quality</li></ul></nav>
      <main>
        <h1>Welcome to the project wiki</h1>
        <p>Wikis provide a place in your repository to lay out the roadmap of your project.</p>
      </main>
      <footer><p>Manage cookies and privacy preferences.</p></footer>
    `;

    const segments = extractReadableSegments(document.body);

    expect(segments.map((segment) => segment.text)).toEqual([
      'Welcome to the project wiki',
      'Wikis provide a place in your repository to lay out the roadmap of your project.',
    ]);
  });

  it('injects once per segment and cleanup removes injected nodes', () => {
    document.body.innerHTML = '<p>A readable paragraph that should receive a translation.</p>';
    const [segment] = extractReadableSegments(document.body);
    expect(segment).toBeDefined();

    injectBilingualText(segment!, {
      text: 'Translated text',
      sourceText: segment!.text,
      targetLanguage: 'zh-CN',
      provider: 'baidu-free',
    });
    injectBilingualText(segment!, {
      text: 'Translated text again',
      sourceText: segment!.text,
      targetLanguage: 'zh-CN',
      provider: 'baidu-free',
    });

    expect(document.querySelectorAll('[data-lingflow-injected="true"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('Translated text again');

    cleanupLingFlow(document.body);
    expect(document.querySelectorAll('[data-lingflow-injected="true"]')).toHaveLength(0);
  });
});
