import { useI18n, type MessageKey } from "../i18n";
import { ApiClientError } from "../api";
import { ValidationError } from "../lib/validation";

export const ErrorNotice = ({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) => {
  const { t } = useI18n();
  const code =
    error instanceof ApiClientError
      ? error.code
      : error instanceof ValidationError
        ? error.code
        : error instanceof Error
          ? error.message
          : "UNKNOWN";
  const validationCode =
    error instanceof ApiClientError && error.code === "VALIDATION_ERROR"
      ? (error.details?.issues as Array<{ message?: string }> | undefined)?.[0]
          ?.message
      : undefined;
  const effectiveCode = validationCode ?? code;
  const key = `error_${effectiveCode}` as MessageKey;
  let message: string | undefined;
  if (effectiveCode === "FILE_TYPE") message = t("fileTypeError");
  else if (effectiveCode === "FILE_DECODE") message = t("fileDecodeError");
  else {
    try {
      message = t(key);
    } catch {
      message = t("error_UNKNOWN");
    }
  }
  if (!message) message = t("error_UNKNOWN");
  const details =
    error instanceof ApiClientError || error instanceof ValidationError
      ? error.details
      : undefined;
  const unsafePosition =
    effectiveCode === "UNSAFE_CONTROL_CHARACTER" &&
    typeof details?.position === "number"
      ? details.position + 1
      : null;
  return (
    <div className="notice notice-error" role="alert">
      <p>{message}</p>
      {unsafePosition !== null ? (
        <p>{t("unsafePosition", { position: unsafePosition })}</p>
      ) : null}
      {onRetry ? (
        <button
          className="button button-secondary"
          type="button"
          onClick={onRetry}
        >
          {t("retry")}
        </button>
      ) : null}
    </div>
  );
};

export const LoadingState = () => {
  const { t } = useI18n();
  return (
    <div className="loading-state" role="status">
      <span className="loading-dot" aria-hidden="true" />
      {t("loading")}
    </div>
  );
};
