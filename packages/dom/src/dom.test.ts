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

  it('does not extract both list containers and nested paragraphs', () => {
    document.body.innerHTML = `
      <ul>
        <li class="flex">
          <div class="marker">•</div>
          <div>
            <p><strong>Auto grouping</strong>: The conversation history is grouped automatically for easier lookup.</p>
          </div>
        </li>
      </ul>
    `;

    const segments = extractReadableSegments(document.body, {
      includePageChrome: true,
      minTextLength: 4,
      scope: 'document',
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]?.element.tagName).toBe('P');
  });

  it('nests below-paragraph translations to avoid flex list reflow', () => {
    document.body.innerHTML = `
      <ul>
        <li style="display: flex">
          <span>•</span>
          <p>A readable paragraph inside a flex list item that should keep the list layout stable.</p>
        </li>
      </ul>
    `;
    const [segment] = extractReadableSegments(document.body, {
      includePageChrome: true,
      minTextLength: 4,
      scope: 'document',
    });

    const injected = injectBilingualText(segment!, {
      text: '译文应该嵌入段落内部，避免成为 flex 列表项的新兄弟元素。',
      sourceText: segment!.text,
      targetLanguage: 'zh-CN',
      provider: 'baidu-free',
    });

    expect(injected.tagName).toBe('SPAN');
    expect(segment!.element.contains(injected)).toBe(true);
    expect(injected.parentElement).toBe(segment!.element);
  });

  it('ignores already injected translations when extracting source text again', () => {
    document.body.innerHTML = '<p>One question, multiple answers: Users can compare model responses.</p>';
    const [segment] = extractReadableSegments(document.body, {
      includePageChrome: true,
      minTextLength: 4,
      scope: 'document',
    });

    injectBilingualText(segment!, {
      text: '一个问题，多个答案：用户可以比较模型回复。',
      sourceText: segment!.text,
      targetLanguage: 'zh-CN',
      provider: 'baidu-free',
    });

    const [rescanned] = extractReadableSegments(document.body, {
      includePageChrome: true,
      minTextLength: 4,
      scope: 'document',
    });

    expect(rescanned?.id).toBe(segment?.id);
    expect(rescanned?.text).toBe('One question, multiple answers: Users can compare model responses.');
  });

  it('removes stale list-level translations when injecting nested paragraph translations', () => {
    document.body.innerHTML = `
      <ul>
        <li>
          <p>Auto grouping keeps every assistant conversation organized for quick lookup.</p>
        </li>
        <div data-lingflow-injected="true">自动分组会保持对话井然有序。</div>
      </ul>
    `;
    const [segment] = extractReadableSegments(document.body, {
      includePageChrome: true,
      minTextLength: 4,
      scope: 'document',
    });

    injectBilingualText(segment!, {
      text: '自动分组会保持每个助手的对话井然有序，便于快速查找。',
      sourceText: segment!.text,
      targetLanguage: 'zh-CN',
      provider: 'baidu-free',
    });

    expect(document.querySelectorAll('[data-lingflow-injected="true"]')).toHaveLength(1);
    expect(segment!.element.querySelector('[data-lingflow-injected="true"]')).not.toBeNull();
  });
});
