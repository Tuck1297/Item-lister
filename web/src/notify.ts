import { notifications } from '@mantine/notifications';

export function notifyError(err: unknown, title = 'Something went wrong') {
  notifications.show({ color: 'red', title, message: err instanceof Error ? err.message : String(err) });
}

export function notifySuccess(message: string, title?: string) {
  notifications.show({ color: 'teal', title, message });
}
