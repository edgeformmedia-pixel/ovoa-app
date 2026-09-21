import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// SecureStore has no web implementation; the web build is only for previews.
const web = Platform.OS === "web";

// Readable while the phone is locked. The keychain's default is "only while
// unlocked", so a band turn or a background push with the phone in a pocket
// couldn't read the chosen voice (it fell back to the default: the voice kept
// changing, device_logs 2026-09-21) or even the saved sign-in.
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

/** What was last read or written, for when the keychain can't be reached. */
const cache = new Map<string, string | null>();
/** Keys already rewritten with the new accessibility this launch. */
const migrated = new Set<string>();

export const storage = {
  get: async (key: string) => {
    if (web) return localStorage.getItem(key);
    try {
      const value = await SecureStore.getItemAsync(key, KEYCHAIN);
      cache.set(key, value);
      // Items saved before this change keep "only while unlocked" until rewritten.
      if (value !== null && !migrated.has(key)) {
        migrated.add(key);
        SecureStore.setItemAsync(key, value, KEYCHAIN).catch(() => migrated.delete(key));
      }
      return value;
    } catch (err) {
      if (cache.has(key)) return cache.get(key) ?? null;
      throw err;
    }
  },
  set: async (key: string, value: string) => {
    cache.set(key, value);
    if (web) return localStorage.setItem(key, value);
    await SecureStore.setItemAsync(key, value, KEYCHAIN);
  },
  remove: async (key: string) => {
    cache.delete(key);
    if (web) return localStorage.removeItem(key);
    await SecureStore.deleteItemAsync(key, KEYCHAIN);
  },
};

/** The shortcut the user builds to send texts without tapping Send (see phoneActions). */
export const SEND_TEXT_SHORTCUT = "OVOA Send Text";

const AUTO_SEND_TEXTS_KEY = "ovoa.autoSendTexts";

/** Send texts through the Shortcuts app instead of the Messages sheet. Off until the user builds it. */
export const autoSendTextsPref = {
  get: async () => (await storage.get(AUTO_SEND_TEXTS_KEY).catch(() => null)) === "1",
  set: (on: boolean) => storage.set(AUTO_SEND_TEXTS_KEY, on ? "1" : "0"),
};

/** Which microphone a summon uses: the phone's, or the ES100's own (record, then transcribe). */
export type MicSource = "phone" | "band";

const MIC_SOURCE_KEY = "ovoa.micSource";

export const micSourcePref = {
  get: async (): Promise<MicSource> => ((await storage.get(MIC_SOURCE_KEY).catch(() => null)) === "band" ? "band" : "phone"),
  set: (source: MicSource) => storage.set(MIC_SOURCE_KEY, source),
};
