import { Link } from "react-router-dom";
import { useI18n } from "../i18n";

export const NotFoundPage = () => {
  const { t } = useI18n();
  return (
    <div className="page page-narrow not-found">
      <p className="not-found-code">404</p>
      <h1>{t("notFoundTitle")}</h1>
      <p>{t("notFoundBody")}</p>
      <Link className="button button-primary" to="/">
        {t("goLibrary")}
      </Link>
    </div>
  );
};
