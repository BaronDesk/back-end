import { Global, Module } from '@nestjs/common';

import { UploadsController } from './controllers/uploads.controller.js';
import { ImagesRepository } from './repository/images.repository.js';
import { ImagesService } from './services/images.service.js';

/** Global: plans, ranks, games and users all keep image links. */
@Global()
@Module({
  controllers: [UploadsController],
  providers: [ImagesService, ImagesRepository],
  exports: [ImagesService],
})
export class UploadsModule {}
