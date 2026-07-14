import { describe, expect, it } from 'vitest';
import {
  inputTranslationShortcutFromKeyEvent,
  mergeDesktopTranslationSettings,
  mergeLingFlowSettings,
  normalizeInputTranslationShortcut,
  resolveInputTranslationDirection,
} from './messages';

describe('normalizeInputTranslationShortcut', () => {
  it('normalizes modifier order and key casing', () => {
    expect(normalizeInputTranslationShortcut('shift + ctrl + enter')).toBe('Ctrl+Shift+Enter');
    expect(normalizeInputTranslationShortcut('alt+q')).toBe('Alt+Q');
  });

  it('supports function and common navigation keys', () => {
    expect(normalizeInputTranslationShortcut('ctrl+f12')).toBe('Ctrl+F12');
    expect(normalizeInputTranslationShortcut('alt+pageDown')).toBe('Alt+PageDown');
  });

  it('rejects shortcuts without a modifier or with multiple regular keys', () => {
    expect(() => normalizeInputTranslationShortcut('Enter')).toThrow(/修饰键/);
    expect(() => normalizeInputTranslationShortcut('Ctrl+E+Q')).toThrow(/一个普通按键/);
  });

  it('captures a shortcut directly from a keyboard event', () => {
    expect(
      inputTranslationShortcutFromKeyEvent({
        altKey: true,
        ctrlKey: false,
        key: 'r',
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe('Alt+R');
  });

  it('waits for a regular key when only a modifier is pressed', () => {
    expect(
      inputTranslationShortcutFromKeyEvent({
        altKey: true,
        ctrlKey: false,
        key: 'Alt',
        metaKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
  });

  it('migrates the previous default without overwriting a custom shortcut', () => {
    expect(mergeLingFlowSettings({ inputTranslationShortcut: 'Ctrl+Shift+Enter' }).inputTranslationShortcut).toBe('Alt+R');
    expect(mergeLingFlowSettings({ inputTranslationShortcut: 'Alt+Q' }).inputTranslationShortcut).toBe('Alt+Q');
    expect(
      mergeLingFlowSettings({
        inputTranslationShortcut: 'Ctrl+Shift+Enter',
        inputTranslationShortcutVersion: 2,
      }).inputTranslationShortcut,
    ).toBe('Ctrl+Shift+Enter');
  });

  it('selects the opposite target language for Chinese and English input', () => {
    expect(resolveInputTranslationDirection('你好，欢迎使用灵流')).toEqual({
      sourceLanguage: 'zh-CN',
      targetLanguage: 'en',
    });
    expect(resolveInputTranslationDirection('Welcome to LingFlow')).toEqual({
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
    });
  });

  it('uses the dominant language for mixed input and rejects language-free text', () => {
    expect(resolveInputTranslationDirection('你好 LingFlow')).toEqual({
      sourceLanguage: 'zh-CN',
      targetLanguage: 'en',
    });
    expect(resolveInputTranslationDirection('This is English 中文')).toEqual({
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
    });
    expect(resolveInputTranslationDirection('12345 !?')).toBeUndefined();
  });

  it('keeps desktop provider credentials while applying extension language choices', () => {
    const extensionSettings = mergeLingFlowSettings({
      provider: 'ai',
      sourceLanguage: 'zh-CN',
      targetLanguage: 'en',
    });
    const desktopAiSource = {
      id: 'desktop-ai',
      name: 'Desktop AI',
      baseUrl: 'https://example.com',
      apiKey: 'desktop-secret',
      models: ['model-a'],
      enabled: true,
    };
    const effective = mergeDesktopTranslationSettings(extensionSettings, {
      provider: 'baidu-free',
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN',
      aiSources: [desktopAiSource],
    });

    expect(effective.provider).toBe('ai');
    expect(effective.sourceLanguage).toBe('zh-CN');
    expect(effective.targetLanguage).toBe('en');
    expect(effective.aiSources).toEqual([desktopAiSource]);
  });
});
