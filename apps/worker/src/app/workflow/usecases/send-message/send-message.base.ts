import { IntegrationEntity, JobEntity, MessageRepository, SubscriberRepository } from '@novu/dal';
import {
  ChannelTypeEnum,
  EmailProviderIdEnum,
  ExecutionDetailsSourceEnum,
  ExecutionDetailsStatusEnum,
  IMessageTemplate,
  SmsProviderIdEnum,
} from '@novu/shared';
import {
  DetailEnum,
  CreateExecutionDetailsCommand,
  SelectIntegration,
  SelectIntegrationCommand,
  GetNovuProviderCredentials,
  SelectVariantCommand,
  SelectVariant,
  ExecutionLogQueueService,
} from '@novu/application-generic';

import { SendMessageType } from './send-message-type.usecase';
import { CreateLog } from '../../../shared/logs';
import { SendMessageCommand } from './send-message.command';

export abstract class SendMessageBase extends SendMessageType {
  abstract readonly channelType: ChannelTypeEnum;
  protected constructor(
    protected messageRepository: MessageRepository,
    protected createLogUsecase: CreateLog,
    protected executionLogQueueService: ExecutionLogQueueService,
    protected subscriberRepository: SubscriberRepository,
    protected selectIntegration: SelectIntegration,
    protected getNovuProviderCredentials: GetNovuProviderCredentials,
    protected selectVariant: SelectVariant
  ) {
    super(messageRepository, createLogUsecase, executionLogQueueService);
  }

  protected async getIntegration(
    selectIntegrationCommand: SelectIntegrationCommand
  ): Promise<IntegrationEntity | undefined> {
    const integration = await this.selectIntegration.execute(SelectIntegrationCommand.create(selectIntegrationCommand));

    if (!integration) {
      return;
    }

    if (integration.providerId === EmailProviderIdEnum.Novu || integration.providerId === SmsProviderIdEnum.Novu) {
      integration.credentials = await this.getNovuProviderCredentials.execute({
        channelType: integration.channel,
        providerId: integration.providerId,
        environmentId: integration._environmentId,
        organizationId: integration._organizationId,
        userId: selectIntegrationCommand.userId,
      });
    }

    return integration;
  }

  protected storeContent(): boolean {
    return this.channelType === ChannelTypeEnum.IN_APP || process.env.STORE_NOTIFICATION_CONTENT === 'true';
  }

  protected getCompilePayload(compileContext) {
    const { payload, ...rest } = compileContext;

    return { ...payload, ...rest };
  }

  protected async sendErrorHandlebars(job: JobEntity, error: string) {
    const metadata = CreateExecutionDetailsCommand.getExecutionLogMetadata();
    await this.executionLogQueueService.add(
      metadata._id,
      CreateExecutionDetailsCommand.create({
        ...metadata,
        ...CreateExecutionDetailsCommand.getDetailsFromJob(job),
        detail: DetailEnum.MESSAGE_CONTENT_NOT_GENERATED,
        source: ExecutionDetailsSourceEnum.INTERNAL,
        status: ExecutionDetailsStatusEnum.FAILED,
        isTest: false,
        isRetry: false,
        raw: JSON.stringify({ error }),
      }),
      job._organizationId
    );
  }

  protected async sendSelectedIntegrationExecution(job: JobEntity, integration: IntegrationEntity) {
    const metadata = CreateExecutionDetailsCommand.getExecutionLogMetadata();
    await this.executionLogQueueService.add(
      metadata._id,
      CreateExecutionDetailsCommand.create({
        ...metadata,
        ...CreateExecutionDetailsCommand.getDetailsFromJob(job),
        detail: DetailEnum.INTEGRATION_INSTANCE_SELECTED,
        source: ExecutionDetailsSourceEnum.INTERNAL,
        status: ExecutionDetailsStatusEnum.PENDING,
        isTest: false,
        isRetry: false,
        raw: JSON.stringify({
          providerId: integration?.providerId,
          identifier: integration?.identifier,
          name: integration?.name,
          _environmentId: integration?._environmentId,
          _id: integration?._id,
        }),
      }),
      job._organizationId
    );
  }

  protected async processVariants(command: SendMessageCommand): Promise<IMessageTemplate> {
    const { messageTemplate, conditions } = await this.selectVariant.execute(
      SelectVariantCommand.create({
        organizationId: command.organizationId,
        environmentId: command.environmentId,
        userId: command.userId,
        step: command.step,
        job: command.job,
        filterData: command.compileContext ?? {},
      })
    );

    if (conditions) {
      const metadata = CreateExecutionDetailsCommand.getExecutionLogMetadata();
      await this.executionLogQueueService.add(
        metadata._id,
        CreateExecutionDetailsCommand.create({
          ...metadata,
          ...CreateExecutionDetailsCommand.getDetailsFromJob(command.job),
          detail: DetailEnum.VARIANT_CHOSEN,
          source: ExecutionDetailsSourceEnum.INTERNAL,
          status: ExecutionDetailsStatusEnum.PENDING,
          isTest: false,
          isRetry: false,
          raw: JSON.stringify({ conditions }),
        }),
        command.job._organizationId
      );
    }

    return messageTemplate;
  }
}
