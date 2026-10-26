import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  CopyButton,
  Drawer,
  Group,
  List,
  Loader,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconAppWindow,
  IconCheck,
  IconCircleCheck,
  IconExternalLink,
  IconLogin,
  IconLogout,
  IconMapPin,
  IconRefresh,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { api, type Connections, type EbayConnection, type EbaySetup, type PolicyKind, type SiteConnection } from '../api';
import { notifyError, notifySuccess } from '../notify';

interface Props {
  opened: boolean;
  onClose: () => void;
  connections: Connections | null;
  onChange: (c: Connections) => void;
}

export function ConnectionsDrawer({ opened, onClose, connections, onChange }: Props) {
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="md" title={<Title order={4}>Connections</Title>}>
      {!connections ? (
        <Loader />
      ) : (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Facebook and Poshmark have no listing API, so Item Lister posts through a browser on this computer. Log in
            once and the session is remembered. eBay connects through its official API.
          </Text>
          {connections.sites.map((site) => (
            <SiteCard key={site.site} site={site} onChange={onChange} />
          ))}
          <EbayCard ebay={connections.ebay} drawerOpen={opened} onChange={onChange} />
        </Stack>
      )}
    </Drawer>
  );
}

// ---------- Facebook / Poshmark ----------

function SiteCard({ site, onChange }: { site: SiteConnection; onChange: (c: Connections) => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, action: () => Promise<Connections>) {
    setBusy(key);
    try {
      onChange(await action());
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(null);
    }
  }

  const status = site.loginOpen ? (
    <Badge color="yellow" variant="light" leftSection={<Loader size={8} color="yellow" />}>
      Waiting for login
    </Badge>
  ) : site.connected ? (
    <Badge color="teal" variant="light" leftSection={<IconCheck size={12} />}>
      Logged in
    </Badge>
  ) : (
    <Badge color="gray" variant="light">
      Not logged in
    </Badge>
  );

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>{site.label}</Text>
          {status}
        </Group>

        {site.loginOpen ? (
          <Text size="sm">
            A browser window is open on the {site.label} login page. Log in there (including any 2-step code). It
            closes by itself once you're in.
          </Text>
        ) : !site.connected ? (
          <Text size="sm" c="dimmed">
            Opens a browser window on this computer so you can log in. Item Lister never sees your password.
          </Text>
        ) : (
          site.checkedAt && (
            <Text size="xs" c="dimmed">
              Last confirmed {new Date(site.checkedAt).toLocaleString()}
            </Text>
          )
        )}

        {site.message && (
          <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />} p="xs">
            <Text size="sm">{site.message}</Text>
          </Alert>
        )}

        <Group gap="xs">
          {site.loginOpen ? (
            <Button
              size="xs"
              variant="default"
              leftSection={<IconAppWindow size={14} />}
              loading={busy === 'login'}
              onClick={() => run('login', () => api.login(site.site))}
            >
              Show login window
            </Button>
          ) : site.connected ? (
            <>
              <Button
                size="xs"
                variant="default"
                leftSection={<IconRefresh size={14} />}
                loading={busy === 'check'}
                onClick={() => run('check', () => api.checkLogin(site.site))}
              >
                Check
              </Button>
              <Button
                size="xs"
                variant="subtle"
                color="red"
                leftSection={<IconLogout size={14} />}
                loading={busy === 'logout'}
                onClick={() => run('logout', () => api.logout(site.site))}
              >
                Log out
              </Button>
            </>
          ) : (
            <>
              <Button
                size="xs"
                leftSection={<IconLogin size={14} />}
                loading={busy === 'login'}
                onClick={() => run('login', () => api.login(site.site))}
              >
                Log in to {site.label}
              </Button>
              <Button
                size="xs"
                variant="subtle"
                color="gray"
                loading={busy === 'check'}
                onClick={() => run('check', () => api.checkLogin(site.site))}
              >
                Already logged in? Check
              </Button>
            </>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}

// ---------- eBay ----------

function EbayCard({
  ebay,
  drawerOpen,
  onChange,
}: {
  ebay: EbayConnection;
  drawerOpen: boolean;
  onChange: (c: Connections) => void;
}) {
  const [redirectUrl, setRedirectUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, action: () => Promise<Connections>, success?: string): Promise<boolean> {
    setBusy(key);
    try {
      onChange(await action());
      if (success) notifySuccess(success);
      return true;
    } catch (err) {
      notifyError(err);
      return false;
    } finally {
      setBusy(null);
    }
  }

  const ready = ebay.connected && ebay.missingSetup.length === 0;

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <Text fw={600}>eBay</Text>
            <Badge size="xs" variant="outline" color={ebay.env === 'production' ? 'teal' : 'gray'}>
              {ebay.env}
            </Badge>
          </Group>
          {ready ? (
            <Badge color="teal" variant="light" leftSection={<IconCheck size={12} />}>
              Ready
            </Badge>
          ) : ebay.connected ? (
            <Badge color="yellow" variant="light">
              Finish setup
            </Badge>
          ) : (
            <Badge color="gray" variant="light">
              Not connected
            </Badge>
          )}
        </Group>

        {ebay.missingKeys.length > 0 ? (
          <Alert color="yellow" variant="light" icon={<IconAlertCircle size={16} />} title="Add your eBay app keys">
            <Text size="sm" mb={6}>
              Create a keyset at{' '}
              <Anchor href="https://developer.ebay.com/my/keys" target="_blank" rel="noopener">
                developer.ebay.com
              </Anchor>
              , then add these to <Code>.env</Code> and restart the server:
            </Text>
            <List size="sm">
              {ebay.missingKeys.map((k) => (
                <List.Item key={k}>
                  <Code>{k}</Code>
                </List.Item>
              ))}
            </List>
          </Alert>
        ) : !ebay.connected ? (
          <Stack gap="xs">
            <Text size="sm">
              1. Sign in to eBay{ebay.env === 'sandbox' ? ' with a sandbox test user' : ''} and click <b>Agree</b>.
            </Text>
            <Button
              component="a"
              href={ebay.consentUrl ?? '#'}
              target="_blank"
              rel="noopener"
              size="xs"
              leftSection={<IconExternalLink size={14} />}
              w="fit-content"
            >
              Open eBay sign-in
            </Button>
            <Text size="sm">2. Paste the address of the page eBay sends you to afterwards.</Text>
            <Group gap="xs" align="flex-end" wrap="nowrap">
              <TextInput
                placeholder="https://…?code=…"
                value={redirectUrl}
                onChange={(e) => setRedirectUrl(e.currentTarget.value)}
                style={{ flex: 1 }}
              />
              <Button
                size="sm"
                disabled={!redirectUrl.trim()}
                loading={busy === 'connect'}
                onClick={() =>
                  run('connect', () => api.ebayConnect(redirectUrl), 'eBay connected. Now pick your policies.').then(
                    (ok) => ok && setRedirectUrl(''),
                  )
                }
              >
                Connect
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              To skip pasting, set your app's "auth accepted URL" on the eBay developer portal to{' '}
              <CopyButton value={ebay.callbackUrl}>
                {({ copied, copy }) => (
                  <Anchor component="button" size="xs" onClick={copy}>
                    {copied ? 'copied' : ebay.callbackUrl}
                  </Anchor>
                )}
              </CopyButton>
              {' '}(if eBay accepts a localhost address).
            </Text>
          </Stack>
        ) : (
          <>
            <EbaySetupPanel active={drawerOpen} onSaved={() => api.connections().then(onChange).catch(() => {})} />
            <Group>
              <Button
                size="xs"
                variant="subtle"
                color="red"
                leftSection={<IconLogout size={14} />}
                loading={busy === 'disconnect'}
                onClick={() => run('disconnect', api.ebayDisconnect)}
              >
                Disconnect eBay
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Paper>
  );
}

const POLICY_LABELS: Record<PolicyKind, string> = {
  fulfillment: 'Shipping policy',
  payment: 'Payment policy',
  return: 'Return policy',
};

function EbaySetupPanel({ active, onSaved }: { active: boolean; onSaved: () => void }) {
  const [setup, setSetup] = useState<EbaySetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [postalCode, setPostalCode] = useState('');

  const load = useCallback(() => {
    setError(null);
    api
      .ebaySetup()
      .then((s) => {
        setSetup(s);
        onSaved();
      })
      .catch((err: Error) => setError(err.message));
  }, [onSaved]);

  useEffect(() => {
    if (active) load();
    // Only reload when the drawer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function run(key: string, action: () => Promise<EbaySetup>) {
    setBusy(key);
    try {
      setSetup(await action());
      onSaved();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return (
      <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />} title="Couldn't load your eBay setup">
        <Text size="sm" mb="xs">
          {error}
        </Text>
        <Button size="xs" variant="light" color="red" onClick={load}>
          Try again
        </Button>
      </Alert>
    );
  }
  if (!setup) {
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          Loading your eBay policies…
        </Text>
      </Group>
    );
  }

  const kinds = Object.keys(POLICY_LABELS) as PolicyKind[];
  const anyMissing = kinds.some((k) => setup.policies[k].length === 0);

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Listings use these business policies from your eBay account.
      </Text>
      {kinds.map((kind) => {
        const key = `${kind}PolicyId` as const;
        return (
          <Select
            key={kind}
            label={POLICY_LABELS[kind]}
            placeholder={setup.policies[kind].length ? 'Choose a policy' : 'None on this account yet'}
            data={setup.policies[kind].map((p) => ({ value: p.id, label: p.name }))}
            value={setup.selected[key] || null}
            disabled={!setup.policies[kind].length || busy !== null}
            allowDeselect={false}
            onChange={(value) => value && run(kind, () => api.saveEbaySetup({ [key]: value }))}
          />
        );
      })}
      {anyMissing && (
        <Alert color="blue" variant="light" p="sm">
          <Text size="sm" mb="xs">
            Missing a policy? Create them in eBay Seller Hub, or add simple starter ones: free USPS Ground Advantage
            shipping, immediate payment, and 30-day returns paid by the buyer.
          </Text>
          <Button size="xs" variant="light" loading={busy === 'defaults'} onClick={() => run('defaults', api.createDefaultPolicies)}>
            Create starter policies
          </Button>
        </Alert>
      )}

      {setup.location.exists ? (
        <Group gap={6}>
          <IconCircleCheck size={16} color="var(--mantine-color-teal-6)" />
          <Text size="sm">
            Ships from location <Code>{setup.location.key}</Code>
          </Text>
        </Group>
      ) : (
        <Stack gap={6}>
          <Text size="sm">
            <IconMapPin size={14} style={{ verticalAlign: -2 }} /> Where do items ship from?
          </Text>
          <Group gap="xs" wrap="nowrap">
            <TextInput
              placeholder="ZIP / postal code"
              value={postalCode}
              onChange={(e) => setPostalCode(e.currentTarget.value)}
              style={{ flex: 1 }}
            />
            <Button
              disabled={!postalCode.trim()}
              loading={busy === 'location'}
              onClick={() => run('location', () => api.createEbayLocation(postalCode.trim()))}
            >
              Save
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}
