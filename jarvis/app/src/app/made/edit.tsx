import { useLocalSearchParams, useNavigation, useRouter, type Href } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { AppEditor } from "../../components/AppEditor";
import { Btn, Screen } from "../../components/ui";
import type { AppDraft, MyApp } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { missingFrom } from "../../lib/appKit";
import { cue } from "../../lib/cues";
import { myApps, useMyApp } from "../../lib/myApps";
import { colors, space, type } from "../../lib/theme";

// Edit one of the apps they made (app/made/[id].tsx → Edit): the whole app in
// the editor, saved only when they say so. Leaving with changes asks first.

const draftOf = (a: MyApp): AppDraft => ({
  name: a.name,
  about: a.about,
  icon: a.icon,
  tone: a.tone,
  instructions: a.instructions,
  opener: a.opener,
  blocks: a.blocks,
  speak: a.speak,
});

export default function EditMadeApp() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const { token, user } = useSession();
  const app = useMyApp(token, id);
  const [draft, setDraft] = useState<AppDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = useRef(false);

  useEffect(() => {
    if (app && !draft) setDraft(draftOf(app));
  }, [app, draft]);

  const dirty = !!app && !!draft && JSON.stringify(draftOf(app)) !== JSON.stringify(draft);

  // Changes aren't thrown away by a stray swipe back.
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (e) => {
        if (!dirty || saved.current) return;
        e.preventDefault();
        Alert.alert("Discard your changes?", "They haven't been saved.", [
          { text: "Keep editing", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => navigation.dispatch(e.data.action),
          },
        ]);
      }),
    [navigation, dirty],
  );

  if (app === null) {
    return (
      <Screen>
        <Text style={styles.sub}>This app was deleted.</Text>
      </Screen>
    );
  }
  if (!app || !draft) return <Screen>{null}</Screen>;

  const save = async () => {
    const missing = missingFrom(draft);
    if (missing) return Alert.alert("Not yet", missing);
    setSaving(true);
    try {
      await myApps.update(token, app.id, draft);
      saved.current = true;
      cue("done");
      router.back();
    } catch (err) {
      Alert.alert("Couldn't save it", err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = () =>
    Alert.alert(`Delete ${app.name}?`, "You made it, so deleting it can't be undone. Its lists and logs go with it.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            saved.current = true;
            await myApps.remove(token, app.id);
            router.dismissTo("/apps" as Href);
          } catch (err) {
            saved.current = false;
            Alert.alert("Couldn't delete it", err instanceof Error ? err.message : String(err));
          }
        },
      },
    ]);

  return (
    // automaticallyAdjustKeyboardInsets: the page scrolls up past the keyboard, so no box or button hides behind it.
    <Screen keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <AppEditor draft={draft} contents={app.state} onChange={setDraft} token={token} assistant={user?.settings.assistantName || "OVOA"} />
      <View style={styles.buttons}>
        <Btn label={dirty ? "Save changes" : "Saved"} kind="go" onPress={() => void save()} busy={saving} disabled={!dirty} />
        {dirty && <Btn label="Undo all" kind="quiet" onPress={() => setDraft(draftOf(app))} disabled={saving} />}
      </View>
      <Btn label={`Delete ${app.name}`} kind="danger" onPress={remove} style={{ marginTop: space.s8, alignSelf: "flex-start" }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  sub: { ...type.sub, color: colors.inkDim, paddingTop: space.s4 },
  buttons: {
    flexDirection: "row",
    gap: space.s2,
    paddingTop: space.s6,
    flexWrap: "wrap",
  },
});
