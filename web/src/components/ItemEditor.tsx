import {
  ActionIcon,
  Autocomplete,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Image,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { Dropzone, type FileWithPath } from '@mantine/dropzone';
import { useForm } from '@mantine/form';
import { IconPhoto, IconStar, IconUpload, IconX } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { api, CONDITIONS, type AppConfig, type Condition, type ItemFull } from '../api';
import { notifyError, notifySuccess } from '../notify';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

interface FormValues {
  title: string;
  description: string;
  price: number | string;
  original_price: number | string;
  quantity: number | string;
  condition: Condition;
  brand: string;
  size: string;
  color: string;
  weight_oz: number | string;
  sku: string;
  ebay_category_id: string;
  ebay_aspects: string;
  facebook_category: string;
  poshmark_category: string;
}

const EMPTY: FormValues = {
  title: '',
  description: '',
  price: '',
  original_price: '',
  quantity: 1,
  condition: 'good',
  brand: '',
  size: '',
  color: '',
  weight_oz: '',
  sku: '',
  ebay_category_id: '',
  ebay_aspects: '',
  facebook_category: '',
  poshmark_category: '',
};

function toValues(item: ItemFull | null): FormValues {
  if (!item) return EMPTY;
  return {
    title: item.title,
    description: item.description,
    price: item.price_cents / 100,
    original_price: item.original_price_cents ? item.original_price_cents / 100 : '',
    quantity: item.quantity,
    condition: item.condition,
    brand: item.brand,
    size: item.size,
    color: item.color,
    weight_oz: item.weight_oz ?? '',
    sku: item.sku,
    ebay_category_id: item.ebay_category_id,
    ebay_aspects: item.ebay_aspects,
    facebook_category: item.facebook_category,
    poshmark_category: item.poshmark_category,
  };
}

interface PendingPhoto {
  file: File;
  preview: string;
}

interface Props {
  item: ItemFull | null;
  opened: boolean;
  config: AppConfig;
  onClose: () => void;
  onSaved: (item: ItemFull) => void;
}

export function ItemEditor({ item, opened, config, onClose, onSaved }: Props) {
  const [pending, setPending] = useState<PendingPhoto[]>([]);
  const [saving, setSaving] = useState<'save' | 'post' | null>(null);
  const postAfterSave = useRef(false);

  const form = useForm<FormValues>({
    mode: 'controlled',
    initialValues: EMPTY,
    validate: {
      title: (v) => (!v.trim() ? 'Title is required' : v.length > 80 ? 'Keep it to 80 characters (eBay/Poshmark limit)' : null),
      price: (v) => (Number(v) > 0 ? null : 'Enter a price'),
      ebay_category_id: (v) => (v && !/^\d+$/.test(v) ? 'Numbers only' : null),
    },
  });

  // Reset whenever the editor opens for a different item.
  const itemId = item?.id ?? null;
  useEffect(() => {
    if (!opened) return;
    form.setValues(toValues(item));
    form.resetDirty(toValues(item));
    form.clearErrors();
    setPending((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.preview));
      return [];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, itemId]);

  function addFiles(files: FileWithPath[]) {
    setPending((prev) => [...prev, ...files.map((file) => ({ file, preview: URL.createObjectURL(file) }))]);
  }

  function removePending(index: number) {
    setPending((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) URL.revokeObjectURL(removed.preview);
      return next;
    });
  }

  async function photoAction(action: () => Promise<ItemFull>) {
    try {
      onSaved(await action());
    } catch (err) {
      notifyError(err);
    }
  }

  async function submit(values: FormValues) {
    const andPost = postAfterSave.current;
    const photoCount = (item?.photos.length ?? 0) + pending.length;
    if (andPost && photoCount === 0) {
      notifyError('Add at least one photo before posting.', 'No photos');
      return;
    }

    const data = new FormData();
    for (const [key, value] of Object.entries(values)) data.append(key, String(value ?? ''));
    for (const p of pending) data.append('photos', p.file, p.file.name);

    setSaving(andPost ? 'post' : 'save');
    try {
      let saved = await api.saveItem(item?.id ?? null, data);
      if (andPost) {
        saved = await api.post(saved.id, config.platforms.map((p) => p.id));
        notifySuccess(
          config.postMode === 'review'
            ? 'Posting started. Facebook and Poshmark will open in a browser window for you to review.'
            : 'Posting started.',
        );
      }
      onSaved(saved);
      onClose();
    } catch (err) {
      notifyError(err, "Couldn't save");
    } finally {
      setSaving(null);
    }
  }

  const titleLength = form.values.title.length;

  return (
    <Modal opened={opened} onClose={onClose} title={item ? 'Edit item' : 'New item'} size="xl" centered>
      <form onSubmit={form.onSubmit(submit)}>
        <Stack gap="lg">
          <Stack gap="xs">
            <Text fw={600} size="sm">
              Photos
            </Text>
            {(item?.photos.length ?? 0) + pending.length > 0 && (
              <Group gap="xs">
                {item?.photos.map((photo, i) => (
                  <Thumb
                    key={photo.id}
                    src={`/uploads/${photo.filename}`}
                    cover={i === 0}
                    onRemove={() => photoAction(() => api.deletePhoto(item.id, photo.id))}
                    onMakeCover={i > 0 ? () => photoAction(() => api.makeCover(item.id, photo.id)) : undefined}
                  />
                ))}
                {pending.map((p, i) => (
                  <Thumb
                    key={p.preview}
                    src={p.preview}
                    cover={(item?.photos.length ?? 0) === 0 && i === 0}
                    unsaved
                    onRemove={() => removePending(i)}
                  />
                ))}
              </Group>
            )}
            <Dropzone
              onDrop={addFiles}
              onReject={(rejections) =>
                notifyError(
                  rejections.map((r) => `${r.file.name}: ${r.errors[0]?.message ?? 'not accepted'}`).join('\n'),
                  'Use JPEG, PNG or WebP photos',
                )
              }
              accept={ACCEPTED}
              maxSize={20 * 1024 * 1024}
              multiple
            >
              <Group justify="center" gap="md" mih={72} style={{ pointerEvents: 'none' }}>
                <Dropzone.Accept>
                  <IconUpload size={32} color="var(--mantine-color-teal-6)" />
                </Dropzone.Accept>
                <Dropzone.Reject>
                  <IconX size={32} color="var(--mantine-color-red-6)" />
                </Dropzone.Reject>
                <Dropzone.Idle>
                  <IconPhoto size={32} color="var(--mantine-color-dimmed)" />
                </Dropzone.Idle>
                <div>
                  <Text size="sm">Drag photos here or click to choose</Text>
                  <Text size="xs" c="dimmed">
                    JPEG, PNG or WebP. The first photo is the cover.
                  </Text>
                </div>
              </Group>
            </Dropzone>
          </Stack>

          <Divider label="Basics" labelPosition="left" />
          <TextInput
            label="Title"
            required
            maxLength={80}
            rightSection={
              <Text size="xs" c={titleLength > 80 ? 'red' : 'dimmed'}>
                {titleLength}/80
              </Text>
            }
            rightSectionWidth={52}
            {...form.getInputProps('title')}
          />
          <Textarea label="Description" autosize minRows={4} maxRows={12} {...form.getInputProps('description')} />
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <NumberInput label="Price" required prefix="$" decimalScale={2} min={0} {...form.getInputProps('price')} />
            <NumberInput
              label="Original price"
              description="Poshmark only"
              prefix="$"
              decimalScale={2}
              min={0}
              {...form.getInputProps('original_price')}
            />
            <NumberInput label="Quantity" min={1} allowDecimal={false} {...form.getInputProps('quantity')} />
            <Select label="Condition" data={CONDITIONS} allowDeselect={false} {...form.getInputProps('condition')} />
            <TextInput label="Brand" {...form.getInputProps('brand')} />
            <TextInput label="Size" {...form.getInputProps('size')} />
            <TextInput label="Color" {...form.getInputProps('color')} />
            <NumberInput label="Weight (oz)" min={0} decimalScale={1} {...form.getInputProps('weight_oz')} />
            <TextInput label="SKU" placeholder="Auto" {...form.getInputProps('sku')} />
          </SimpleGrid>

          <Divider label="Platform details" labelPosition="left" />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label="eBay category ID"
              placeholder="Blank = suggest from title"
              inputMode="numeric"
              {...form.getInputProps('ebay_category_id')}
            />
            <Autocomplete
              label="Facebook category"
              placeholder="e.g. Household"
              data={config.facebookCategories}
              {...form.getInputProps('facebook_category')}
            />
          </SimpleGrid>
          <TextInput
            label="Poshmark category"
            placeholder="Women > Tops > Blouses"
            {...form.getInputProps('poshmark_category')}
          />
          <Textarea
            label="eBay item specifics"
            description="One per line as Name: value. Use | for several values."
            placeholder={'Department: Women\nType: Blouse'}
            autosize
            minRows={2}
            {...form.getInputProps('ebay_aspects')}
          />

          <Group justify="flex-end" gap="xs">
            <Button variant="subtle" color="gray" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              loading={saving === 'save'}
              disabled={saving !== null}
              onClick={() => (postAfterSave.current = false)}
            >
              Save
            </Button>
            <Button
              type="submit"
              loading={saving === 'post'}
              disabled={saving !== null}
              onClick={() => (postAfterSave.current = true)}
            >
              Save & post to all
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

interface ThumbProps {
  src: string;
  cover: boolean;
  unsaved?: boolean;
  onRemove: () => void;
  onMakeCover?: () => void;
}

function Thumb({ src, cover, unsaved, onRemove, onMakeCover }: ThumbProps) {
  return (
    <Box pos="relative" w={88} h={88}>
      <Image
        src={src}
        w={88}
        h={88}
        radius="sm"
        fit="cover"
        alt=""
        style={unsaved ? { outline: '2px dashed var(--mantine-primary-color-filled)', outlineOffset: -2 } : undefined}
      />
      {cover && (
        <Badge size="xs" pos="absolute" bottom={4} left={4} variant="filled">
          Cover
        </Badge>
      )}
      <Group gap={4} pos="absolute" top={4} right={4}>
        {onMakeCover && (
          <Tooltip label="Make cover">
            <ActionIcon size="sm" variant="white" color="dark" onClick={onMakeCover} aria-label="Make cover">
              <IconStar size={12} />
            </ActionIcon>
          </Tooltip>
        )}
        <Tooltip label={unsaved ? 'Remove' : 'Delete photo'}>
          <ActionIcon size="sm" variant="white" color="red" onClick={onRemove} aria-label="Remove photo">
            <IconX size={12} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Box>
  );
}
