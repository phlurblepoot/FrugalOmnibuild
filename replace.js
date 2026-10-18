const fs = require('fs');
const path = require('path');

const files = [
  'src/pages/ProjectView.tsx',
  'src/pages/CanvasView.tsx',
  'src/components/PdfCanvas.tsx',
];

files.forEach(file => {
  const filePath = path.join(__dirname, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace types
  content = content.replace(/MeasurementGroup/g, 'MeasurementTakeoff');
  
  // Replace property names
  content = content.replace(/\.groups/g, '.takeoffs');
  content = content.replace(/groupId/g, 'takeoffId');
  
  // Replace variable names
  content = content.replace(/newGroup/g, 'newTakeoff');
  content = content.replace(/editGroup/g, 'editTakeoff');
  content = content.replace(/editingGroup/g, 'editingTakeoff');
  content = content.replace(/handleCreateGroup/g, 'handleCreateTakeoff');
  content = content.replace(/handleEditGroup/g, 'handleEditTakeoff');
  content = content.replace(/handleDeleteGroup/g, 'handleDeleteTakeoff');
  content = content.replace(/handleSaveEditGroup/g, 'handleSaveEditTakeoff');
  content = content.replace(/showGroupModal/g, 'showTakeoffModal');
  content = content.replace(/setShowGroupModal/g, 'setShowTakeoffModal');
  content = content.replace(/expandedGroups/g, 'expandedTakeoffs');
  content = content.replace(/setExpandedGroups/g, 'setExpandedTakeoffs');
  content = content.replace(/toggleGroupExpanded/g, 'toggleTakeoffExpanded');
  content = content.replace(/groupTotals/g, 'takeoffTotals');
  content = content.replace(/getGroupTotals/g, 'getTakeoffTotals');
  content = content.replace(/groupMeasurements/g, 'takeoffMeasurements');
  content = content.replace(/selectedGroupId/g, 'selectedTakeoffId');
  content = content.replace(/setSelectedGroupId/g, 'setSelectedTakeoffId');
  content = content.replace(/handleGroupChange/g, 'handleTakeoffChange');
  content = content.replace(/onChangeGroup/g, 'onChangeTakeoff');
  
  // Replace UI text
  content = content.replace(/Group Name/g, 'Takeoff Name');
  content = content.replace(/New Group/g, 'New Takeoff');
  content = content.replace(/Edit Group/g, 'Edit Takeoff');
  content = content.replace(/Delete Group/g, 'Delete Takeoff');
  content = content.replace(/Groups/g, 'Takeoffs');
  content = content.replace(/groups/g, 'takeoffs');
  content = content.replace(/group/g, 'takeoff');
  content = content.replace(/Group/g, 'Takeoff');
  
  // Fix some casing issues that might arise
  content = content.replace(/takeoffId/g, 'takeoffId'); // just in case
  
  fs.writeFileSync(filePath, content, 'utf8');
});
