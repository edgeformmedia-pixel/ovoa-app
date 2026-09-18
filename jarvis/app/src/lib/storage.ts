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
