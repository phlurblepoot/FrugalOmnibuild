import React, { useEffect, useState } from 'react';
import { createBrowserRouter, RouterProvider, Outlet, useLocation, Navigate } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import { PageTransition } from './components/motion/PageTransition';
import { Dashboard } from './pages/Dashboard';
import { ProjectsPage } from './pages/ProjectsPage';
import { NewProject } from './pages/NewProject';
import { ProjectView } from './pages/ProjectView';
import { CanvasView } from './pages/CanvasView';
import { ProjectLayout } from './pages/project/ProjectLayout';
import { ProjectOverview } from './pages/project/ProjectOverview';
import { ShareTargetPage } from './pages/ShareTargetPage';
import { DocumentsPage, ProjectDocuments } from './pages/documents/DocumentsPage';
import { MailPage } from './pages/mail/MailPage';
import { ProjectNotes } from './pages/project/ProjectNotes';
import { ProjectTime } from './pages/project/ProjectTime';
import { ProjectBilling } from './pages/project/ProjectBilling';
import { ProjectIssues } from './pages/project/ProjectIssues';
import { ProjectRfis } from './pages/project/ProjectRfis';
import { ProjectDailyReports } from './pages/project/ProjectDailyReports';
import { ProjectMail } from './pages/project/ProjectMail';
import { ProjectPunch } from './pages/project/ProjectPunch';
import { ProposalsList } from './pages/project/proposal/ProposalsList';
import { ProposalEditor } from './pages/project/proposal/ProposalEditor';
import { ProjectSettings } from './pages/project/ProjectSettings';
import { Login } from './pages/Login';
import { RestorePage } from './pages/RestorePage';
import { Settings } from './pages/Settings';
import { DocumentEditor } from './pages/DocumentEditor';
import { TasksPage } from './pages/TasksPage';
import { TimeKeeping } from './pages/TimeKeeping';
import { CustomersSplitView } from './pages/customers/CustomersSplitView';
import { ReportsPage } from './pages/reports/ReportsPage';
import { ShareView } from './pages/ShareView';
import { AttachmentViewer } from './pages/AttachmentViewer';
import { CollaborationProvider } from './context/CollaborationContext';
import { NotificationsProvider } from './context/NotificationsContext';
import { NotesProvider } from './context/NotesContext';
import { FollowPill } from './components/FollowPill';
import { ThemeWipe } from './components/shell/ThemeWipe';
import { CelebrationOverlay } from './components/motion/Celebration';
import { NotesOverlay } from './components/NotesOverlay';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/ConfirmDialog';
import { ShareProvider } from './components/ShareLinkModal';
import { CommandPalette } from './components/CommandPalette';
import { AppShell } from './components/shell/AppShell';
import ProjectConflictListener from './components/ProjectConflictListener';
import { getSettings } from './utils/store';
import { isBareRoute } from './utils/locationInfo';

const Layout: React.FC<{ appName: string; logoUrl: string }> = ({ appName, logoUrl }) => {
  const location = useLocation();
  // /restore is the fresh-install twin of /login: same chrome-free treatment.
  const isBare = isBareRoute(location.pathname);

  return (
    <ToastProvider>
      <ProjectConflictListener />
      <ConfirmProvider>
        <ShareProvider>
          <CollaborationProvider>
            <NotificationsProvider>
              <NotesProvider>
                {!isBare && <CommandPalette />}
                <AppShell appName={appName}>
                  <FollowPill />
                  <ThemeWipe />
                  <CelebrationOverlay />
                  <NotesOverlay />
                  <PageTransition>
                    <Outlet context={{ appName, logoUrl }} />
                  </PageTransition>
                </AppShell>
              </NotesProvider>
            </NotificationsProvider>
          </CollaborationProvider>
        </ShareProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
};

export default function App() {
  const [appName, setAppName] = useState('FrugalOmnibuild');
  const [logoUrl, setLogoUrl] = useState('');

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const settings = await getSettings();
        if (settings.appName) {
          setAppName(settings.appName);
          document.title = settings.appName;
        }
        if (settings.logoUrl) {
          setLogoUrl(settings.logoUrl);
        }
      } catch (error) {
        console.error('Failed to fetch settings:', error);
      }
    };
    fetchSettings();
  }, []);

  /** Old editor addresses → the document editor, keeping ?fileId=. */
const LegacyEditorRedirect: React.FC = () => {
  const { search } = useLocation();
  return <Navigate to={`/tools/edit${search}`} replace />;
};

const router = createBrowserRouter([
    {
      path: '/',
      element: <Layout appName={appName} logoUrl={logoUrl} />,
      children: [
        {
          path: 'login',
          element: <Login />,
        },
        {
          path: 'restore',
          element: <RestorePage />,
        },
        {
          index: true,
          element: <Navigate to="/dashboard" replace />,
        },
        {
          path: 'dashboard',
          element: <Dashboard />,
        },
        {
          path: 'projects',
          element: <ProjectsPage />,
        },
        {
          path: 'new',
          element: <NewProject />,
        },
        {
          path: 'project/:projectId',
          element: <ProjectLayout />,
          children: [
            { index: true, element: <ProjectOverview /> },
            { path: 'takeoff', element: <ProjectView /> },
            { path: 'proposal', element: <ProposalsList /> },
            { path: 'proposal/:proposalId', element: <ProposalEditor /> },
            { path: 'documents', element: <ProjectDocuments /> },
            { path: 'notes', element: <ProjectNotes /> },
            { path: 'time', element: <ProjectTime /> },
            { path: 'punch', element: <ProjectPunch /> },
            { path: 'issues', element: <ProjectIssues /> },
            { path: 'rfis', element: <ProjectRfis /> },
            { path: 'daily-reports', element: <ProjectDailyReports /> },
            { path: 'mail', element: <ProjectMail /> },
            { path: 'billing', element: <ProjectBilling /> },
            { path: 'settings', element: <ProjectSettings /> },
            { path: 'page/:pageId', element: <CanvasView /> },
          ],
        },
        {
          path: 'settings',
          element: <Settings />,
        },
        {
          path: 'tools/edit',
          element: <DocumentEditor />,
        },
        {
          // A mail attachment in the ONLYOFFICE viewer (Phase 6).
          path: 'tools/view',
          element: <AttachmentViewer />,
        },
        // The ONLYOFFICE editor replaced the separate PDF and spreadsheet
        // editors; their old addresses (bookmarks, emailed links) still work.
        ...['tools/pdf', 'tools/sheets', 'pdf-editor', 'spreadsheet-editor'].map(path => ({
          path,
          element: <LegacyEditorRedirect />,
        })),
        {
          path: 'customers',
          element: <CustomersSplitView />,
        },
        {
          path: 'customers/:id',
          element: <CustomersSplitView />,
        },
        {
          path: 'tasks',
          element: <TasksPage />,
        },
        {
          path: 'share-target',
          element: <ShareTargetPage />,
        },
        {
          path: 'documents',
          element: <DocumentsPage />,
        },
        {
          path: 'mail',
          element: <MailPage />,
        },
        {
          path: 'mail/:accountId',
          element: <MailPage />,
        },
        {
          path: 'mail/:accountId/:folderId',
          element: <MailPage />,
        },
        {
          path: 'mail/:accountId/:folderId/:threadKey',
          element: <MailPage />,
        },
        {
          path: 'time',
          element: <TimeKeeping />,
        },
        {
          path: 'reports',
          element: <ReportsPage />,
        },
      ],
    },
    {
      path: '/share/:shareId',
      element: <ShareView />,
    },
  ]);

  return <ThemeProvider><RouterProvider router={router} /></ThemeProvider>;
}
