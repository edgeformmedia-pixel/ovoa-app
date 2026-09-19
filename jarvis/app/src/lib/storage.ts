import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// SecureStore has no web implementation; the web build is only for previews.
const web = Platform.OS === "web";

export const storage = {
  get: (key: string) => (web ? Promise.resolve(localStorage.getItem(key)) : SecureStore.getItemAsync(key)),
  set: (key: string, value: string) =>
    web ? Promise.resolve(localStorage.setItem(key, value)) : SecureStore.setItemAsync(key, value),
  remove: (key: string) =>
    web ? Promise.resolve(localStorage.removeItem(key)) : SecureStore.deleteItemAsync(key),
};

/** The shortcut the user builds to send texts without tapping Send (see phoneActions). */
export const SEND_TEXT_SHORTCUT = "OVOA Send Text";

const AUTO_SEND_TEXTS_KEY = "ovoa.autoSendTexts";

/** Send texts through the Shortcuts app instead of the Messages sheet. Off until the user builds it. */
export const autoSendTextsPref = {
  get: async () => (await storage.get(AUTO_SEND_TEXTS_KEY).catch(() => null)) === "1",
  set: (on: boolean) => storage.set(AUTO_SEND_TEXTS_KEY, on ? "1" : "0"),
};
