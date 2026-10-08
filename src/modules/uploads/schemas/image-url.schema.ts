import { z } from 'zod';

import { UPLOADED_IMAGE_URL } from '../util/image-files.js';

/**
 * A badgeUrl / iconUrl: a link answered by POST /uploads/images, or null to
 * remove the image. Any other link is refused, so a page never loads an
 * image from elsewhere.
 */
export const uploadedImageUrlSchema = z
  .string()
  .regex(UPLOADED_IMAGE_URL, 'must be a link answered by POST /uploads/images (/uploads/images/<id>.webp)')
  .nullable();
