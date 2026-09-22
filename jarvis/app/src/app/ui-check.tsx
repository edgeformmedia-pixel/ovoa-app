// TEMPORARY — verification scaffold, deleted before the work is handed over.
// Renders the white design's parts with fixed data so they can be looked at
// without a session. Not linked from anywhere.
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { DrawerHost, DrawerPanel } from "../components/Drawer";
import { Answer, Spine, type Moment } from "../components/Spine";
import { Btn, Empty, GroupLabel, IconTile, Row, Screen, Tile, Tiles, Toggle, TopBar, text } from "../components/ui";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors, lift, space } from "../lib/theme";

const RECENT = [
  { id: "1", title: "Text Sarah — running 15 late" },
  { id: "2", title: "The dentist moved you to 11:45" },
  { id: "3", title: "Did Priya ask for the charger?" },
];

export default function UiCheck() {
  return (
    <DrawerHost
      panel={(close) => (
        <DrawerPanel
          current="/day"
          tails={{ Day: "3 new", Safety: "Armed" }}
          recent={RECENT}
          onClose={close}
          onGo={() => close()}
        />
      )}
    >
      <Parts />
    </DrawerHost>
  );
}

const T = (h: number, m: number) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
const NOW = T(14, 41);

const MOMENTS: Moment[] = [
  { id: "a", at: "09:15", sortAt: T(9, 15), title: "Strength training", state: "kept" },
  { id: "b", at: "11:45", sortAt: T(11, 45), title: "Dentist", state: "done" },
  { id: "c", at: "12:40", sortAt: T(12, 40), title: "Inbox — nothing to say", state: "agentQuiet" },
  { id: "d", at: "13:05", sortAt: T(13, 5), title: "Call with Priya", state: "done" },
  {
    id: "e",
    at: "13:10",
    sortAt: T(13, 10),
    title: "",
    state: "agent",
    answer: (
      <Answer eyebrow="Did they ask?" said="“can you bring the charger”" who="Priya Raman">
        <Btn label="Keep it" onPress={() => {}} />
        <Btn label="No" kind="quiet" onPress={() => {}} />
      </Answer>
    ),
  },
  { id: "f", at: "13:20", sortAt: T(13, 20), title: "Stretch break", state: "missed" },
  {
    id: "g",
    at: "14:45",
    sortAt: T(14, 45),
    title: "Afternoon meds",
    state: "now",
    answer: (
      <Answer>
        <Btn label="Done" kind="go" onPress={() => {}} />
        <Btn label="Snooze" kind="quiet" onPress={() => {}} />
      </Answer>
    ),
  },
  { id: "h", at: "17:30", sortAt: T(17, 30), title: "Prescription", state: "next", onDone: () => {} },
  { id: "i", at: "18:40", sortAt: T(18, 40), title: "Priya's train", state: "next", onDone: () => {} },
  { id: "j", at: "22:00", sortAt: T(22, 0), title: "Quiet hours", state: "next" },
];

function Parts() {
  const [on, setOn] = useState(true);
  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <TopBar title="Day" when="Sun 21 Sep" />
      <Screen>
        <Spine moments={MOMENTS} now={NOW} />

        <GroupLabel>The orb</GroupLabel>
        <View style={{ alignItems: "center", gap: 12, paddingVertical: 16 }}>
          <View style={{ width: 208, height: 208, alignItems: "center", justifyContent: "center" }}>
            <View style={{ position: "absolute", width: 208, height: 208, borderRadius: 104, backgroundColor: colors.nowWash, opacity: 0.6 }} />
            <View style={{ width: 172, height: 172, borderRadius: 86, backgroundColor: colors.paper, alignItems: "center", justifyContent: "center", ...lift }}>
              <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, borderRadius: 86, borderWidth: 3, borderColor: colors.agent, borderTopColor: colors.now, borderRightColor: colors.now }} />
              <Ionicons name="mic-outline" size={40} color={colors.ink} />
            </View>
          </View>
          <Text style={{ fontSize: 28, lineHeight: 32, fontWeight: "400", color: colors.ink }}>Listening</Text>
          <Text style={[text.body, { color: colors.inkDim, textAlign: "center" }]}>text Sarah I'm running about fifteen minutes late</Text>
          <Text style={text.sub}>Tap the orb to turn it off</Text>
        </View>

        <GroupLabel>Background tiles</GroupLabel>
        <Tiles>
          <Tile icon="sparkles-outline" tone="violet" label="Autonomy" value="Suggest" small />
          <Tile icon="moon-outline" tone="blue" label="Quiet" value="22 – 07" small />
          <Tile icon="flash-outline" tone="teal" label="Runs today" value="12" suffix=" / 40" />
          <Tile icon="refresh-outline" tone="green" label="Jobs" value="3" suffix=" on" />
          <Tile icon="locate-outline" tone="amber" label="Goals" value="2" />
          <Tile icon="list-outline" tone="pink" label="Run log" value="Today" small />
        </Tiles>

        <GroupLabel>Standing jobs</GroupLabel>
        <Row icon="sunny-outline" tone="amber" title="Morning brief" first right={<Toggle value={on} onValueChange={setOn} />} />
        <Row icon="checkmark-done-outline" tone="violet" title="Commitment sweep" right={<Toggle value={on} onValueChange={setOn} />} />
        <Row icon="mail-outline" tone="blue" title="Landlord watch" value="09:00" />

        <GroupLabel>Buttons</GroupLabel>
        <View style={{ flexDirection: "row", gap: space.s2, flexWrap: "wrap" }}>
          <Btn label="Send" kind="go" onPress={() => {}} />
          <Btn label="Keep it" onPress={() => {}} />
          <Btn label="No" kind="quiet" onPress={() => {}} />
          <Btn label="Delete" kind="danger" onPress={() => {}} />
        </View>

        <GroupLabel>Type</GroupLabel>
        <Text style={text.display}>7,412</Text>
        <Text style={text.title}>Title 22</Text>
        <Text style={text.lead}>Lead 19 — a moment due now</Text>
        <Text style={text.head}>Head 17</Text>
        <Text style={text.body}>Body 17 the quick brown fox</Text>
        <Text style={text.sub}>Sub 15 the quick brown fox</Text>
        <Text style={text.meta}>Meta 13 the quick brown fox</Text>
        <Text style={text.micro}>Micro 11</Text>

        <GroupLabel>Tones</GroupLabel>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.s2 }}>
          <IconTile name="mic" tone="teal" />
          <IconTile name="git-branch-outline" tone="violet" />
          <IconTile name="shield-checkmark-outline" tone="green" />
          <IconTile name="sunny-outline" tone="amber" />
          <IconTile name="pulse" tone="coral" />
          <IconTile name="radio-button-on" tone="blue" />
          <IconTile name="list-outline" tone="pink" />
        </ScrollView>

        <Empty icon="checkmark-done-outline" title="Nothing to report" body="An empty screen means nothing needed you." />
      </Screen>
    </View>
  );
}

export const styles = StyleSheet.create({});
