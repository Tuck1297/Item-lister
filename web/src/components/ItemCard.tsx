import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Group,
  Image,
  Loader,
  Menu,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  IconArrowBackUp,
  IconCheck,
  IconDots,
  IconExternalLink,
  IconPencil,
  IconPhoto,
  IconSend,
  IconTag,
  IconTrash,
} from '@tabler/icons-react';
import { useState } from 'react';
import { api, BUSY, CONDITIONS, money, STATUS, type AppConfig, type ItemFull, type Platform } from '../api';
import { notifyError } from '../notify';

interface Props {
  item: ItemFull;
  platforms: AppConfig['platforms'];
  onEdit: () => void;
  onChange: (item: ItemFull) => void;
  onDelete: () => void;
}

export function ItemCard({ item, platforms, onEdit, onChange, onDelete }: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const sold = item.status === 'sold';
  const cover = item.photos[0];

  async function run(key: string, action: () => Promise<ItemFull | void>) {
    setPending(key);
    try {
      const updated = await action();
      if (updated) onChange(updated);
    } catch (err) {
      notifyError(err);
    } finally {
      setPending(null);
    }
  }

  const confirmDelete = () =>
    modals.openConfirmModal({
      title: 'Delete item?',
      children: (
        <Text size="sm">
          “{item.title}” and its photos will be removed from Item Lister. Live listings on eBay, Facebook and Poshmark
          are not touched.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        void run('delete', async () => {
          await api.deleteItem(item.id);
          onDelete();
        }),
    });

  const meta = [
    CONDITIONS.find((c) => c.value === item.condition)?.label,
    item.brand,
    item.size && `Size ${item.size}`,
    `SKU ${item.sku}`,
  ].filter(Boolean);

  return (
    <Card withBorder padding="md" radius="md" opacity={sold ? 0.65 : 1}>
      <Group align="flex-start" wrap="nowrap" gap="md">
        {cover ? (
          <Image src={`/uploads/${cover.filename}`} w={96} h={96} radius="md" fit="cover" alt="" />
        ) : (
          <Center w={96} h={96} bg="var(--mantine-color-default-hover)" style={{ borderRadius: 'var(--mantine-radius-md)', flexShrink: 0 }}>
            <IconPhoto size={28} color="var(--mantine-color-dimmed)" />
          </Center>
        )}

        <Stack gap={8} style={{ flex: 1, minWidth: 0 }}>
          <Group justify="space-between" align="flex-start" gap="xs">
            <Box style={{ minWidth: 0, flex: 1 }}>
              <Group gap="xs" wrap="nowrap">
                <Title order={4} lineClamp={1}>
                  {item.title}
                </Title>
                {sold && (
                  <Badge color="gray" variant="filled" size="sm">
                    Sold
                  </Badge>
                )}
              </Group>
              <Text size="sm" c="dimmed" lineClamp={1}>
                <Text span fw={700} c="var(--mantine-color-text)">
                  {money(item.price_cents)}
                </Text>
                {' · '}
                {meta.join(' · ')}
              </Text>
            </Box>

            <Group gap="xs" wrap="nowrap">
              {!sold && (
                <Button
                  size="xs"
                  leftSection={<IconSend size={14} />}
                  loading={pending === 'all'}
                  onClick={() => run('all', () => api.post(item.id, platforms.map((p) => p.id)))}
                >
                  Post to all
                </Button>
              )}
              <Button size="xs" variant="default" leftSection={<IconPencil size={14} />} onClick={onEdit}>
                Edit
              </Button>
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon variant="default" size={30} aria-label="More actions" loading={pending === 'menu'}>
                    <IconDots size={16} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {sold ? (
                    <Menu.Item leftSection={<IconArrowBackUp size={14} />} onClick={() => run('menu', () => api.unmarkSold(item.id))}>
                      Unmark sold
                    </Menu.Item>
                  ) : (
                    <Menu.Item leftSection={<IconTag size={14} />} onClick={() => run('menu', () => api.markSold(item.id))}>
                      Mark sold (ends eBay listing)
                    </Menu.Item>
                  )}
                  <Menu.Divider />
                  <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={confirmDelete}>
                    Delete
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Group>
          </Group>

          <SimpleGrid cols={{ base: 1, sm: platforms.length }} spacing="xs">
            {platforms.map((p) => (
              <Channel
                key={p.id}
                item={item}
                platform={p.id}
                label={p.label.replace(' Marketplace', '')}
                pending={pending === p.id}
                onPost={() => run(p.id, () => api.post(item.id, [p.id]))}
                onDelisted={() => run(p.id, () => api.markDelisted(item.id, p.id))}
              />
            ))}
          </SimpleGrid>
        </Stack>
      </Group>
    </Card>
  );
}

interface ChannelProps {
  item: ItemFull;
  platform: Platform;
  label: string;
  pending: boolean;
  onPost: () => void;
  onDelisted: () => void;
}

function Channel({ item, platform, label, pending, onPost, onDelisted }: ChannelProps) {
  const listing = item.listings.find((l) => l.platform === platform);
  const status = listing?.status;
  const busy = status ? BUSY.includes(status) : false;
  const isError = status === 'failed' || status === 'delist_manually';

  // Re-posting to Facebook/Poshmark would create a duplicate; eBay updates in place.
  let postLabel: string | null = null;
  if (item.status !== 'sold' && !busy && !(status === 'listed' && platform !== 'ebay')) {
    postLabel = !status ? 'Post' : status === 'failed' ? 'Retry' : status === 'listed' ? 'Update' : 'Repost';
  }

  return (
    <Paper withBorder p="xs" radius="md">
      <Stack gap={6} h="100%">
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text size="sm" fw={600}>
            {label}
          </Text>
          <Badge
            variant="light"
            size="sm"
            color={status ? STATUS[status].color : 'gray'}
            leftSection={status === 'posting' || status === 'queued' ? <Loader size={8} color="blue" /> : undefined}
          >
            {status ? STATUS[status].label : 'Not posted'}
          </Badge>
        </Group>

        {listing?.message && (
          <Tooltip label={listing.message} multiline w={320} openDelay={400}>
            <Text size="xs" c={isError ? 'red' : 'dimmed'} lineClamp={3}>
              {listing.message}
            </Text>
          </Tooltip>
        )}

        <Group gap="xs" mt="auto">
          {postLabel && (
            <Button size="compact-xs" variant="default" loading={pending} onClick={onPost}>
              {postLabel}
            </Button>
          )}
          {status === 'delist_manually' && (
            <Button size="compact-xs" variant="light" color="orange" leftSection={<IconCheck size={12} />} loading={pending} onClick={onDelisted}>
              Done
            </Button>
          )}
          {listing?.url && status === 'listed' && (
            <Anchor href={listing.url} target="_blank" rel="noopener" size="xs">
              <Group gap={2} wrap="nowrap">
                View <IconExternalLink size={12} />
              </Group>
            </Anchor>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}
