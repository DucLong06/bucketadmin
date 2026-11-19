import { useEffect, useState } from "react";
import {
  Alert,
  AppBar,
  Container,
  CssBaseline,
  Tab,
  Tabs,
  ThemeProvider,
  Toolbar,
  Typography,
  createTheme,
} from "@mui/material";
import { invoke, type Profile } from "./api";
import Audit from "./Audit";
import Browse from "./Browse";
import Buckets from "./Buckets";
import Clusters from "./Clusters";
import { ErrorAlert } from "./ui";
import Users from "./Users";

const theme = createTheme({ palette: { mode: "dark" } });

export default function App() {
  const [page, setPage] = useState("users");
  // The user the Browse page works as; set from a user's drawer or typed on the page.
  const [browseUid, setBrowseUid] = useState("");
  const browseAs = (uid: string) => {
    setBrowseUid(uid);
    setPage("browse");
  };
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [clusterId, setClusterId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = () =>
    invoke<Profile[]>("list_profiles")
      .then((list) => {
        setProfiles(list);
        // Keep the current cluster while it still exists, otherwise fall back to the first one.
        setClusterId((id) => (list.some((p) => p.id === id) ? id : (list[0]?.id ?? "")));
      })
      .catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppBar position="static" color="default">
        <Toolbar variant="dense">
          <Typography variant="h6" component="div" sx={{ mr: 4 }}>
            BucketAdmin
          </Typography>
          <Tabs value={page} onChange={(_, value) => setPage(value)} aria-label="Điều hướng chính">
            <Tab value="users" label="Users" />
            <Tab value="buckets" label="Buckets" />
            <Tab value="browse" label="Browse" />
            <Tab value="clusters" label="Clusters" />
            <Tab value="audit" label="Audit" />
          </Tabs>
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: 3 }}>
        <ErrorAlert error={error} />
        {page === "users" && (
          <Users profiles={profiles} clusterId={clusterId} onClusterChange={setClusterId} onBrowse={browseAs} />
        )}
        {page === "browse" && (
          <Browse
            profiles={profiles}
            clusterId={clusterId}
            onClusterChange={setClusterId}
            uid={browseUid}
            onUid={setBrowseUid}
            onProfilesChanged={reload}
          />
        )}
        {page === "buckets" && <Buckets profiles={profiles} clusterId={clusterId} onClusterChange={setClusterId} />}
        {page === "clusters" && <Clusters profiles={profiles} onChanged={reload} />}
        {page === "audit" && <Audit profiles={profiles} />}
      </Container>
    </ThemeProvider>
  );
}
