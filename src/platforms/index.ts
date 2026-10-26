import type { Platform } from '../types';
import { ebay } from './ebay';
import { facebook } from './facebook';
import { poshmark } from './poshmark';
import type { Publisher } from './types';

export const publishers: Record<Platform, Publisher> = { ebay, facebook, poshmark };
