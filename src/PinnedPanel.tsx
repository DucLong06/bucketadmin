import { type MouseEvent, useState } from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, List, ListItemButton, ListItemIcon, ListItemText, Menu, MenuItem, Paper, TextField, IconButton, Typography } from "@mui/material";
import type { Profile } from "./api";
import { t } from "./i18n";
import { splitPath } from "./paths";
import { SOURCE_ICON } from "./PathPicker";
import { defaultLabel, filterPins, orderPins, pinLabel, type Pin, type PinOps } from "./pins";
import { placeLabel, type Place } from "./tabs";
import { thinScroll, tokens } from "./theme";
import { FoldHeading, ListFilter, PinIcon } from "./ui";

/** The card gets a filter field above this many rows. */
export const PINS_FILTER_ABOVE = 5;

type Props = {
  pins: Pin[];
  /** The start paths of the connection being browsed (with its own key): the first rows of the card. */
  startPaths?: string[];
  profiles: Profile[];
  /** The connection being browsed in this tab: its pins come first. */
  clusterId: string;
  /** Open the place in this tab. */
  onOpen: (at: Place) => void;
  /** Open the place in a new tab. */
  onOpenTab: (at: Place) => void;
  ops: PinOps;
  /** Pin a path that is typed or picked (the path picker). */
  onAdd?: () => void;
  /** The card is folded to its heading (a saved choice, shared by every tab), and how to change that. */
  folded: boolean;
  onFold: (folded: boolean) => void;
};

/** The sidebar's Pinned card, under the buckets. Pins of other connections are listed too, greyed
 *  under a divider: every pin stays one click away. The list scrolls inside the card, and the
 *  whole card folds to its heading when the user wants the room for what is below it. */
export default function PinnedPanel({ pins, startPaths = [], profiles, clusterId, onOpen, onOpenTab, ops, onAdd, folded, onFold }: Props) {
  // Right-clicked pin (with its position in the whole list) and where the pointer was.
  const [menu, setMenu] = useState<{ pin: Pin; index: number; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<Pin | null>(null);
  const [name, setName] = useState("");
  // The filter belongs to this tab and is not saved.
  const [filter, setFilter] = useState("");
  if (pins.length === 0 && startPaths.length === 0) return null;
  const filterable = pins.length + startPaths.length > PINS_FILTER_ABOVE;
  const wanted = filterable ? filter.trim().toLowerCase() : "";
  const starts = startPaths.filter((path) => path.toLowerCase().includes(wanted));
  const startPlace = (path: string): Place => {
    const at = splitPath(path);
    return { clusterId, uid: "", bucket: at.error ? "" : at.bucket, prefix: at.error ? "" : at.prefix };
  };
  // Filtered after ordering: a pin keeps its position in the whole list (moving it up or down means that list).
  const matching = new Set(filterable ? filterPins(pins, filter) : pins);
  const ordered = orderPins(pins, clusterId);
  const [here, elsewhere] = [ordered.here, ordered.elsewhere].map((group) => group.filter(({ pin }) => matching.has(pin)));
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
      <FoldHeading
        title={t("browse.bucketsCount", { title: t("browse.pinned"), n: pins.length })}
        open={!folded}
        onToggle={() => onFold(!folded)}
        controls="pinned-list"
        action={
          onAdd && (
            <IconButton aria-label={t("pins.addHere")} title={t("pins.addHere")} onClick={onAdd} sx={{ width: 40, height: 40, fontSize: 20 }}>
              +
            </IconButton>
          )
        }
      />
      {!folded && filterable && (
        <Box sx={{ px: 1.5, pb: 1 }}>
          <ListFilter placeholder={t("pins.filter")} value={filter} onChange={setFilter} shown={matching.size + starts.length} total={pins.length + startPaths.length} />
        </Box>
      )}
      {!folded && matching.size + starts.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 1.5 }}>
          {t("list.filterNone")}
        </Typography>
      )}
      {!folded && (
        <List dense id="pinned-list" aria-label={t("browse.pinnedList")} style={{ maxHeight: 216 }} sx={{ ...thinScroll, pt: 0 }}>
          {/* Where the connection says its key works: not pins (nothing to rename or unpin), but as near. */}
          {starts.length > 0 && (
            <Divider component="li" textAlign="left" sx={{ my: 0.5, fontSize: 12.5, color: "text.secondary" }}>
              {t("pins.fromConnection")}
            </Divider>
          )}
          {starts.map((path) => (
            <ListItemButton
              key={`start ${path}`}
              title={t("pathPicker.source.start")}
              onClick={(e: MouseEvent) => (e.ctrlKey || e.metaKey ? onOpenTab(startPlace(path)) : onOpen(startPlace(path)))}
              onAuxClick={(e: MouseEvent) => e.button === 1 && onOpenTab(startPlace(path))}
            >
              <ListItemIcon data-source="start" sx={{ minWidth: 28, color: "text.secondary" }}>
                {SOURCE_ICON.start}
              </ListItemIcon>
              <ListItemText primary={path} slotProps={{ primary: { sx: { fontFamily: tokens.mono, fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } } }} />
            </ListItemButton>
          ))}
          {here.map((entry) => row(entry, true))}
          {elsewhere.length > 0 && (
            <Divider component="li" textAlign="left" sx={{ my: 0.5, fontSize: 12.5, color: "text.secondary" }}>
              {t("browse.pinsElsewhere")}
            </Divider>
          )}
          {elsewhere.map((entry) => row(entry, false))}
        </List>
      )}
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
