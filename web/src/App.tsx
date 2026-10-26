import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Paper,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  Tooltip,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { IconMoon, IconPlug, IconPlus, IconSearch, IconSun } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, BUSY, type AppConfig, type Connections, type ItemFull } from './api';
import { ConnectionsDrawer } from './components/ConnectionsDrawer';
import { ItemCard } from './components/ItemCard';
import { ItemEditor } from './components/ItemEditor';
import { notifyError, notifySuccess } from './notify';

/** Counts eBay as connected only once its policies are chosen too. */
export function connectedCount(c: Connections | null): { done: number; total: number } {
  if (!c) return { done: 0, total: 3 };
  const sites = c.sites.filter((s) => s.connected).length;
  const ebay = c.ebay.connected && c.ebay.missingSetup.length === 0 ? 1 : 0;
  return { done: sites + ebay, total: c.sites.length + 1 };
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [items, setItems] = useState<ItemFull[] | null>(null);
  const [connections, setConnections] = useState<Connections | null>(null);
  const [editing, setEditing] = useState<ItemFull | 'new' | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [showSold, setShowSold] = useState(false);

  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');

  const loadItems = useCallback(() => api.items().then(setItems).catch((err) => notifyError(err, "Couldn't load items")), []);
  const loadConnections = useCallback(() => api.connections().then(setConnections).catch(() => {}), []);

  useEffect(() => {
    api.config().then(setConfig).catch((err) => notifyError(err, "Couldn't reach the server"));
    void loadItems();
    void loadConnections();

    // Back from eBay's sign-in page (when the auth accepted URL points at this server).
    const params = new URLSearchParams(window.location.search);
    if (params.has('ebay')) notifySuccess('eBay is connected. Pick your policies to finish setup.');
    if (params.has('ebay_error')) notifyError(params.get('ebay_error'), "Couldn't connect eBay");
    if (params.has('ebay') || params.has('ebay_error')) {
      setConnectionsOpen(true);
      window.history.replaceState({}, '', '/');
    }
  }, [loadItems, loadConnections]);

  // Poll fast while something is posting, slowly otherwise.
  const busy = items?.some((i) => i.listings.some((l) => BUSY.includes(l.status))) ?? false;
  useEffect(() => {
    const timer = setInterval(() => void loadItems(), busy ? 2000 : 15000);
    return () => clearInterval(timer);
  }, [busy, loadItems]);

  const loginOpen = connections?.sites.some((s) => s.loginOpen) ?? false;
  useEffect(() => {
    const timer = setInterval(() => void loadConnections(), loginOpen ? 1500 : 30000);
    return () => clearInterval(timer);
  }, [loginOpen, loadConnections]);

  const upsert = useCallback((item: ItemFull) => {
    setItems((prev) => {
      const list = prev ?? [];
      return list.some((i) => i.id === item.id) ? list.map((i) => (i.id === item.id ? item : i)) : [item, ...list];
    });
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (items ?? []).filter(
      (i) =>
        (showSold || i.status !== 'sold') &&
        (!q || [i.title, i.sku, i.brand].some((v) => v.toLowerCase().includes(q))),
    );
  }, [items, search, showSold]);

  const { done, total } = connectedCount(connections);

  return (
    <AppShell header={{ height: 60 }} padding="md">
      <AppShell.Header>
        <Container size="lg" h="100%">
          <Group h="100%" justify="space-between" wrap="nowrap">
            <Group gap="xs" wrap="nowrap">
              <Title order={3}>Item Lister</Title>
              {config && (
                <Badge variant="light" color="gray" visibleFrom="sm">
                  {config.postMode === 'auto' ? 'Auto-publish' : 'Review before publish'}
                </Badge>
              )}
            </Group>
            <Group gap="xs" wrap="nowrap">
              <Button
                variant="default"
                leftSection={<IconPlug size={16} />}
                rightSection={
                  <Badge size="sm" color={done === total ? 'teal' : 'yellow'} variant="light">
                    {done}/{total}
                  </Badge>
                }
                onClick={() => setConnectionsOpen(true)}
              >
                Connections
              </Button>
              <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing('new')}>
                New item
              </Button>
              <Tooltip label={scheme === 'dark' ? 'Light mode' : 'Dark mode'}>
                <ActionIcon
                  variant="default"
                  size="lg"
                  aria-label="Toggle color scheme"
                  onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')}
                >
                  {scheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>
        </Container>
      </AppShell.Header>

      <AppShell.Main>
        <Container size="lg">
          <Stack gap="md">
            {connections && done < total && (
              <Alert color="yellow" variant="light" title="Finish connecting your accounts">
                <Group justify="space-between" align="center">
                  <Text size="sm">
                    {done === 0
                      ? 'Log in to Facebook and Poshmark and connect eBay so items can be posted.'
                      : `${total - done} of ${total} platforms still need to be connected.`}
                  </Text>
                  <Button size="xs" variant="light" color="yellow" onClick={() => setConnectionsOpen(true)}>
                    Open connections
                  </Button>
                </Group>
              </Alert>
            )}

            <Group justify="space-between">
              <TextInput
                placeholder="Search title, SKU, brand…"
                leftSection={<IconSearch size={16} />}
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                w={{ base: '100%', sm: 340 }}
              />
              <Switch label="Show sold" checked={showSold} onChange={(e) => setShowSold(e.currentTarget.checked)} />
            </Group>

            {items === null || config === null ? (
              <Center py="xl">
                <Loader />
              </Center>
            ) : items.length === 0 ? (
              <Paper withBorder p="xl" radius="md">
                <Stack align="center" gap="sm">
                  <Text c="dimmed" ta="center">
                    No items yet. Add photos and details once, then post to eBay, Facebook and Poshmark.
                  </Text>
                  <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing('new')}>
                    Add your first item
                  </Button>
                </Stack>
              </Paper>
            ) : visible.length === 0 ? (
              <Text c="dimmed" ta="center" py="xl">
                No items match.
              </Text>
            ) : (
              visible.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  platforms={config.platforms}
                  onEdit={() => setEditing(item)}
                  onChange={upsert}
                  onDelete={() => setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? null)}
                />
              ))
            )}
          </Stack>
        </Container>
      </AppShell.Main>

      {config && (
        <ItemEditor
          item={editing === 'new' ? null : editing}
          opened={editing !== null}
          config={config}
          onClose={() => setEditing(null)}
          onSaved={(item) => {
            upsert(item);
            if (editing !== 'new' && editing) setEditing(item);
          }}
        />
      )}

      <ConnectionsDrawer
        opened={connectionsOpen}
        onClose={() => setConnectionsOpen(false)}
        connections={connections}
        onChange={setConnections}
      />
    </AppShell>
  );
}
