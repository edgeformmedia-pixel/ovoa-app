// TEMPORARY — verification scaffold, deleted before the work is handed over.
// Renders the white design's parts with fixed data so they can be looked at
// without a session. Not linked from anywhere.
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { DrawerHost, DrawerPanel } from "../components/Drawer";
import { Btn, Empty, GroupLabel, IconTile, Row, Screen, Tile, Tiles, Toggle, TopBar, text } from "../components/ui";
import { colors, space } from "../lib/theme";

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

function Parts() {
  const [on, setOn] = useState(true);
  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <TopBar title="Background" when="Sun 21 Sep" />
      <Screen>
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
