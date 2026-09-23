import { useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { YourPlan } from "../../components/Plan";
import { Btn, GroupLabel, Row, Screen, TopBar } from "../../components/ui";
import { api } from "../../lib/api";
import { useSession } from "../../lib/auth";
import { colors, space, type } from "../../lib/theme";

// Who you are to OVOA: your plan, your name and email, your password, and the
// ways out. Split from Settings, which is now only how OVOA behaves.

export default function Account() {
  const { token, user, setUser, signOut, clear } = useSession();
  const [name, setName] = useState(user?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");

  if (!user) return null; // signing out

  const saveName = async () => {
    setSaving(true);
    try {
      setUser((await api.updateMe(token, { name: name.trim() })).user);
    } catch (err) {
      Alert.alert("Couldn't save", (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async () => {
    if (newPw.length < 8) return Alert.alert("New password must be at least 8 characters");
    try {
      await api.changePassword(token, currentPw, newPw);
      setCurrentPw("");
      setNewPw("");
      Alert.alert("Password changed", "Other devices have been signed out.");
    } catch (err) {
      Alert.alert("Couldn't change password", (err as Error).message);
    }
  };

  const deleteAccount = () =>
    Alert.alert("Delete your account?", "This permanently deletes your account, chats, and memories.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          api
            .deleteAccount(token)
            .then(clear)
            .catch((err) => Alert.alert("Something went wrong", err.message)),
      },
    ]);

  return (
    <View style={styles.page}>
      <TopBar title="Account" />
      <Screen keyboardShouldPersistTaps="handled">
        <GroupLabel>Your plan</GroupLabel>
        <YourPlan />

        <GroupLabel>You</GroupLabel>
        <View style={styles.section}>
          <Row icon="mail-outline" tone="blue" title="Email" value={user.email} first />
          <Field label="Your name" value={name} onChangeText={setName} />
          <Btn
            label={saving ? "Saving…" : "Save name"}
            onPress={saveName}
            disabled={!name.trim() || name.trim() === user.name || saving}
            style={styles.btn}
          />
        </View>

        <GroupLabel>Password</GroupLabel>
        <View style={styles.section}>
          <Field label="Current password" value={currentPw} onChangeText={setCurrentPw} secureTextEntry />
          <Field label="New password" value={newPw} onChangeText={setNewPw} secureTextEntry />
          <Btn label="Change password" onPress={changePassword} disabled={!currentPw || !newPw} style={styles.btn} />
        </View>

        <GroupLabel>Session</GroupLabel>
        <View style={styles.section}>
          <Btn label="Sign out" onPress={signOut} style={styles.btn} />
          <Btn label="Delete account" kind="danger" onPress={deleteAccount} style={styles.btn} />
        </View>
      </Screen>
    </View>
  );
}

function Field({ label, ...props }: { label: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.inkMute}
        autoCorrect={!props.secureTextEntry}
        autoCapitalize={props.secureTextEntry ? "none" : "words"}
        {...props}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  section: { gap: space.s3 },
  label: { ...type.body, color: colors.ink },
  btn: { alignSelf: "flex-start" },
  input: {
    backgroundColor: colors.wash,
    borderRadius: 14,
    color: colors.ink,
    ...type.body,
    paddingHorizontal: space.s3,
    paddingVertical: space.s3,
  },
});
