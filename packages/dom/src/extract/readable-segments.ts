import {
  LINGFLOW_INJECTED_ATTRIBUTE,
  LINGFLOW_SEGMENT_ATTRIBUTE,
  type ExtractReadableSegmentsOptions,
  type ReadableSegment,
} from '../types.js';

const DEFAULT_BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, dd, dt, figcaption';
const FULL_PAGE_BLOCK_SELECTOR = DEFAULT_BLOCK_SELECTOR;
const BASE_SKIP_SELECTOR = [
  'script',
  'style',
  'noscript',
  'textarea',
  'input',
  'select',
  'option',
  'code',
  'pre',
  'svg',
  'canvas',
  'iframe',
  'kbd',
  'samp',
  '[hidden]',
  '[aria-hidden="true"]',
  '[data-testid="file-tree"]',
  '[data-testid="list-row-repo-name-and-number"]',
  '[data-hpc]',
  '[data-turbo-frame]',
  '[data-view-component]',
  '[role="grid"]',
  '[role="tree"]',
  '[role="treegrid"]',
  '[role="table"]',
  `[${LINGFLOW_INJECTED_ATTRIBUTE}]`,
].join(',');

const PAGE_CHROME_SKIP_SELECTOR = 'nav, header, footer, aside, [role="navigation"]';
const INTERACTIVE_SKIP_SELECTOR = [
  'button',
  '[role="button"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="tablist"]',
  '[contenteditable="true"]',
  '[data-testid="Dropdown"]',
  '[data-testid="caret"]',
].join(',');

const STRUCTURAL_SKIP_SELECTOR = [
  '.react-directory-row',
  '.PRIVATE_TreeView-item',
  '.js-navigation-item',
  '.Box-row',
  '.file',
  '.file-wrap',
  '.blob-wrapper',
  '.blob-code',
  '.blob-num',
  '.markdown-alert',
  '.highlight',
  '.gist',
  '.commit',
  '.TimelineItem',
  '.js-issue-row',
].join(',');

const AUTHOR_SKIP_SELECTOR = [
  '[rel="author"]',
  '[itemprop="author"]',
  '[data-hovercard-type="user"]',
  '[data-testid="User-Name"]',
  '[data-testid="UserCell"]',
  '[data-testid="UserAvatar-Container"]',
  '.author',
  '.byline',
  '.username',
  '.user-name',
  '.fullname',
  '.avatar',
  '.user-mention',
].join(',');

const GITHUB_SKIP_SELECTOR = [
  'header',
  'nav',
  '[role="navigation"]',
  '[aria-label="Global"]',
  '[aria-label="Repository"]',
  '[aria-label="Repository navigation"]',
  '[aria-label="Breadcrumb"]',
  '[data-testid="repository-navigation"]',
  '.UnderlineNav',
  '.AppHeader',
  '.Header',
  '#repository-container-header',
  '.file-navigation',
  '.js-repo-nav',
  '.js-navigation-container',
  '.js-active-navigation-container',
  '[aria-label="Files"]',
  '[aria-label="Repository files"]',
  '[aria-labelledby="folders-and-files"]',
  '[data-testid="folders-and-files"]',
  '[data-testid="tree-entry"]',
  '[data-testid="latest-commit"]',
  '[data-testid="file-row"]',
  '[data-testid="file-tree"]',
  '[data-testid="react-directory-row"]',
  '.react-directory-row',
  '.react-directory-filename-column',
  '.react-directory-commit-message',
  '.react-directory-age-column',
  '.PRIVATE_TreeView-item',
].join(',');

const CONTENT_ROOT_SELECTOR = [
  'article',
  'main',
  '[role="main"]',
  '.markdown-body',
  '.entry-content',
  '.post-content',
  '.article-content',
  '#readme',
].join(',');

export function extractReadableSegments(
  root: ParentNode = document.body,
  options: ExtractReadableSegmentsOptions = {},
): ReadableSegment[] {
  const minTextLength = options.minTextLength ?? 12;
  const maxSegments = options.maxSegments ?? 120;
  const blockSelector = options.scope === 'document' ? FULL_PAGE_BLOCK_SELECTOR : DEFAULT_BLOCK_SELECTOR;
  const scope = options.scope === 'document' ? root : pickReadableScope(root);
  const elements = Array.from(scope.querySelectorAll<HTMLElement>(blockSelector));
  const candidates: ReadableSegment[] = [];

  for (const element of elements) {
    if (shouldSkipElement(element, options) || hasReadableBlockChild(element)) {
      continue;
    }

    const text = getReadableText(element);
    if (text.length < minTextLength) {
      continue;
    }

    const id = element.getAttribute(LINGFLOW_SEGMENT_ATTRIBUTE) || createSegmentId(candidates.length);
    element.setAttribute(LINGFLOW_SEGMENT_ATTRIBUTE, id);
    candidates.push({ id, element, text });
  }

  return dedupeNestedSegments(candidates).slice(0, maxSegments);
}

export function findReadableSegmentFromSelection(
  selection: Selection | null = document.getSelection(),
  fallbackText?: string,
) {
  if ((!selection || selection.rangeCount === 0 || selection.isCollapsed) && !fallbackText) {
    return undefined;
  }

  const node = selection?.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const block = findNearestReadableBlock(element);
  if (!block || shouldSkipElement(block)) {
    return undefined;
  }

  const selectedText = normalizeText(selection?.toString() || fallbackText || '');
  const blockText = getReadableText(block);
  const text = selectedText || blockText;
  if (!text) {
    return undefined;
  }

  const id = block.getAttribute(LINGFLOW_SEGMENT_ATTRIBUTE) || createSegmentId(Date.now());
  block.setAttribute(LINGFLOW_SEGMENT_ATTRIBUTE, id);
  return { id, element: block, text };
}

function shouldSkipElement(element: HTMLElement, options: ExtractReadableSegmentsOptions = {}) {
  const skipSelectors = [
    BASE_SKIP_SELECTOR,
    options.includePageChrome ? '' : PAGE_CHROME_SKIP_SELECTOR,
    options.includeInteractiveText ? '' : INTERACTIVE_SKIP_SELECTOR,
    STRUCTURAL_SKIP_SELECTOR,
    AUTHOR_SKIP_SELECTOR,
    isGitHubPage() ? GITHUB_SKIP_SELECTOR : '',
  ].filter(Boolean).join(',');

  if (element.closest(skipSelectors)) {
    return true;
  }

  const style = window.getComputedStyle(element);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0'
  ) {
    return true;
  }

  return isLikelyCodeOrDataCell(element);
}

function hasReadableBlockChild(element: HTMLElement) {
  return Boolean(element.querySelector(DEFAULT_BLOCK_SELECTOR));
}

function dedupeNestedSegments(candidates: ReadableSegment[]) {
  const selected: ReadableSegment[] = [];
  const deepestFirst = [...candidates].sort((left, right) => getElementDepth(right.element) - getElementDepth(left.element));

  for (const candidate of deepestFirst) {
    if (selected.some((segment) => isDuplicateNestedSegment(candidate, segment))) {
      continue;
    }

    selected.push(candidate);
  }

  return selected.sort((left, right) => {
    if (left.element === right.element) {
      return 0;
    }

    const position = left.element.compareDocumentPosition(right.element);
    return position & 2 ? 1 : -1;
  });
}

function isDuplicateNestedSegment(candidate: ReadableSegment, selected: ReadableSegment) {
  const hasContainment =
    candidate.element.contains(selected.element) ||
    selected.element.contains(candidate.element);

  if (!hasContainment) {
    return false;
  }

  return areEquivalentSegmentTexts(candidate.text, selected.text);
}

function areEquivalentSegmentTexts(left: string, right: string) {
  const leftKey = normalizeText(left);
  const rightKey = normalizeText(right);
  if (leftKey === rightKey) {
    return true;
  }

  const shorter = leftKey.length <= rightKey.length ? leftKey : rightKey;
  const longer = leftKey.length > rightKey.length ? leftKey : rightKey;
  if (shorter.length < 12) {
    return false;
  }

  return longer.includes(shorter) && shorter.length / longer.length >= 0.82;
}

function getElementDepth(element: HTMLElement) {
  let depth = 0;
  let current: Element | null = element;
  while (current?.parentElement) {
    depth += 1;
    current = current.parentElement;
  }
  return depth;
}

function isLikelyCodeOrDataCell(element: HTMLElement) {
  const className = element.className.toString();
  if (/\b(blob|code|file|directory|repo|commit|sha|octicon|diff|markdown-title|PRIVATE_TreeView)\b/i.test(className)) {
    return true;
  }

  const text = getReadableText(element);
  if (!text) {
    return true;
  }

  if (/^[\w./@#:_-]+$/.test(text) && text.length <= 80) {
    return true;
  }

  if (isLikelyUserIdentity(text)) {
    return true;
  }

  return false;
}

function isLikelyUserIdentity(text: string) {
  if (/^@[\w.-]{2,30}$/.test(text)) {
    return true;
  }

  if (/^@[\w.-]{2,30}\s*[·•]\s*/.test(text)) {
    return true;
  }

  return false;
}

function isGitHubPage() {
  return typeof window !== 'undefined' && /(^|\.)github\.com$/i.test(window.location.hostname);
}

function pickReadableScope(root: ParentNode) {
  if (root instanceof HTMLElement && root.matches(CONTENT_ROOT_SELECTOR)) {
    return root;
  }

  const scopes = Array.from(root.querySelectorAll<HTMLElement>(CONTENT_ROOT_SELECTOR)).filter(
    (element) => !shouldSkipElement(element),
  );

  if (scopes.length === 0) {
    return root;
  }

  return scopes
    .map((element) => ({
      element,
      score: getReadableText(element).length,
    }))
    .sort((left, right) => right.score - left.score)[0]?.element ?? root;
}

function findNearestReadableBlock(element?: Element | null) {
  let current: Element | null | undefined = element;
  while (current && current !== document.body) {
    if (current instanceof HTMLElement && current.matches(DEFAULT_BLOCK_SELECTOR)) {
      return current;
    }

    current = current.parentElement;
  }

  current = element;
  while (current && current !== document.body) {
    if (current instanceof HTMLElement && !shouldSkipElement(current)) {
      const text = getReadableText(current);
      if (text.length > 0 && text.length < 2000) {
        return current;
      }
    }

    current = current.parentElement;
  }

  return undefined;
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function getReadableText(element: HTMLElement) {
  const clone = element.cloneNode(true);
  if (!(clone instanceof HTMLElement)) {
    return '';
  }

  clone.querySelectorAll(`[${LINGFLOW_INJECTED_ATTRIBUTE}]`).forEach((node) => node.remove());
  return normalizeText(clone.textContent || '');
}

function createSegmentId(seed: number) {
  return `lf-${Date.now().toString(36)}-${seed.toString(36)}`;
}
