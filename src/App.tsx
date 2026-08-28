import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppDataProvider } from "./app-data";
import { AppShell } from "./components/AppShell";
import { LoadingState } from "./components/Feedback";

const DictationPage = lazy(() =>
  import("./pages/DictationPage").then((module) => ({
    default: module.DictationPage,
  })),
);
const EditSongPage = lazy(() =>
  import("./pages/EditSongPage").then((module) => ({
    default: module.EditSongPage,
  })),
);
const ImportPage = lazy(() =>
  import("./pages/ImportPage").then((module) => ({
    default: module.ImportPage,
  })),
);
const LibraryPage = lazy(() =>
  import("./pages/LibraryPage").then((module) => ({
    default: module.LibraryPage,
  })),
);
const NotFoundPage = lazy(() =>
  import("./pages/NotFoundPage").then((module) => ({
    default: module.NotFoundPage,
  })),
);
const PrivacyPage = lazy(() =>
  import("./pages/PrivacyPage").then((module) => ({
    default: module.PrivacyPage,
  })),
);
const SongPage = lazy(() =>
  import("./pages/SongPage").then((module) => ({
    default: module.SongPage,
  })),
);

export const App = () => (
  <BrowserRouter>
    <AppDataProvider>
      <AppShell>
        <Suspense fallback={<LoadingState />}>
          <Routes>
            <Route path="/" element={<LibraryPage />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/songs/:id" element={<SongPage />} />
            <Route path="/songs/:id/edit" element={<EditSongPage />} />
            <Route path="/dictation/:id" element={<DictationPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </AppShell>
    </AppDataProvider>
  </BrowserRouter>
);
