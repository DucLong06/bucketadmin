import { type MouseEvent, useState } from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, List, ListItemButton, ListItemIcon, ListItemText, Menu, MenuItem, Paper, TextField, Typography } from "@mui/material";
import type { Profile } from "./api";
import { t } from "./i18n";
import { defaultLabel, orderPins, pinLabel, type Pin, type PinOps } from "./pins";
import { placeLabel, type Place } from "./tabs";
import { eyebrow, thinScroll, tokens } from "./theme";
import { PinIcon } from "./ui";

type Props = {
  pins: Pin[];
  profiles: Profile[];
  /** The connection being browsed in this tab: its pins come first. */
  clusterId: string;
  /** Open the place in this tab. */
  onOpen: (at: Place) => void;
  /** Open the place in a new tab. */
  onOpenTab: (at: Place) => void;
  ops: PinOps;
};

/** The sidebar's Pinned card. Pins of other connections are listed too, greyed under a divider
 *  rather than hidden behind a toggle: every pin stays one click away with no hidden state, and
 *  the list scrolls inside the card, so they cost the column no height. */
export default function PinnedPanel({ pins, profiles, clusterId, onOpen, onOpenTab, ops }: Props) {
  // Right-clicked pin (with its position in the whole list) and where the pointer was.
  const [menu, setMenu] = useState<{ pin: Pin; index: number; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<Pin | null>(null);
  const [name, setName] = useState("");
  if (pins.length === 0) return null;
  const { here, elsewhere } = orderPins(pins, clusterId);
  const pick = (action: (pin: Pin, index: number) => void) => () => {
    if (menu) action(menu.pin, menu.index);
    setMenu(null);
  };
  const row = ({ pin, index }: { pin: Pin; index: number }, mine: boolean) => (
    <ListItemButton
      key={JSON.stringify(pin.place)}
      title={placeLabel(pin.place, profiles)}
      // Ctrl+click and the middle button open a new tab, as they do in a browser.
      onClick={(e: MouseEvent) => (e.ctrlKey || e.metaKey ? onOpenTab(pin.place) : onOpen(pin.place))}
      onAuxClick={(e: MouseEvent) => e.button === 1 && onOpenTab(pin.place)}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        setMenu({ pin, index, x: e.clientX, y: e.clientY });
      }}
      sx={{ color: mine ? "text.primary" : "text.secondary" }}
    >
      <ListItemIcon sx={{ minWidth: 28, color: mine ? "primary.main" : "text.secondary" }}>
        <PinIcon filled />
      </ListItemIcon>
      {/* A path is shown in the monospace face; a name the user gave is ordinary text. */}
      <ListItemText primary={pinLabel(pin)} slotProps={{ primary: { sx: { fontFamily: pin.label ? undefined : tokens.mono, fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } } }} />
    </ListItemButton>
  );
  return (
    <Paper variant="outlined" sx={{ borderRadius: "16px" }}>
      <Typography component="h2" sx={{ ...eyebrow, color: "text.secondary", px: 2, pt: 2 }}>
        {t("browse.pinned")}
      </Typography>
      <List dense aria-label={t("browse.pinnedList")} style={{ maxHeight: 216 }} sx={thinScroll}>
        {here.map((entry) => row(entry, true))}
        {elsewhere.length > 0 && (
          <Divider component="li" textAlign="left" sx={{ my: 0.5, fontSize: 12.5, color: "text.secondary" }}>
            {t("browse.pinsElsewhere")}
          </Divider>
        )}
        {elsewhere.map((entry) => row(entry, false))}
      </List>
      <Menu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}
        slotProps={{ list: { "aria-label": t("pins.menu") } }}
      >
        <MenuItem onClick={pick((pin) => onOpenTab(pin.place))}>{t("pins.openTab")}</MenuItem>
        <MenuItem
          onClick={pick((pin) => {
            setName(pin.label);
            setRenaming(pin);
          })}
        >
          {t("pins.rename")}
        </MenuItem>
        <MenuItem onClick={pick((pin) => ops.toggle(pin.place))}>{t("browse.unpin")}</MenuItem>
        <MenuItem disabled={menu?.index === 0} onClick={pick((pin, index) => ops.move(pin.place, index - 1))}>
          {t("pins.moveUp")}
        </MenuItem>
        <MenuItem disabled={menu?.index === pins.length - 1} onClick={pick((pin, index) => ops.move(pin.place, index + 1))}>
          {t("pins.moveDown")}
        </MenuItem>
      </Menu>
      <Dialog open={renaming !== null} onClose={() => setRenaming(null)} maxWidth="xs" fullWidth aria-labelledby="pin-rename-title">
        <Box
          component="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (renaming) ops.rename(renaming.place, name.trim());
            setRenaming(null);
          }}
        >
          <DialogTitle id="pin-rename-title">{t("pins.renameTitle")}</DialogTitle>
          <DialogContent>
            <TextField
              label={t("pins.label")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              size="small"
              fullWidth
              autoFocus
              sx={{ mt: 1 }}
              helperText={renaming ? t("pins.labelHelp", { path: defaultLabel(renaming.place) }) : undefined}
              slotProps={{ htmlInput: { maxLength: 80 } }}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setRenaming(null)}>{t("common.cancel")}</Button>
            <Button type="submit" variant="contained">
              {t("common.save")}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </Paper>
  );
}
