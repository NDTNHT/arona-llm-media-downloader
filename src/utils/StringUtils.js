
export class StringUtils {
  static stripThinkBlocks(text) {
    if (!text) return '';
    let s = String(text);
    // Remove <think>...</think> blocks
    s = s.replace(
      /<think>[\s\S]*?(<\/think>|<\s*\[PLHD21_never_used_51bce0c785ca2f68081bfa7d91973934\]\s*>)/gi,
      ''
    );
    s = s.replace(/<think>[\s\S]*$/gi, '');
    s = s.replace(/<\s*\/?\s*think\s*>/gi, '');
    // Remove specific placeholder if exists
    s = s.replace(/<\s*\[PLHD21_never_used_51bce0c785ca2f68081bfa7d91973934\]\s*>/gi, '');
    return s.trim();
  }

  static sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
