import * as path from 'path';
import * as vscode from 'vscode';
import {
	TestAdapter,
	TestEvent,
	TestLoadFinishedEvent,
	TestLoadStartedEvent,
	TestRunFinishedEvent,
	TestRunStartedEvent,
	TestSuiteEvent
} from 'vscode-test-adapter-api';
import { TestInfo, TestSuiteInfo } from 'vscode-test-adapter-api';
import { Log } from 'vscode-test-adapter-util';
import { isModSupported } from './goModules';
import { extractInstanceTestName, findAllTestSuiteRuns, getTestFlags, getTestFunctions, goTest, TestConfig, } from './testUtils';
import { byteOffsetAt, getGoConfig } from './util';
const fs = require('fs').promises;

interface SuiteWrapper {
	item: (TestSuiteInfo | TestInfo);
	functionName: string;
	testSuites: string[];
}
export class GoTestAdapter implements TestAdapter {

	get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> { return this.testsEmitter.event; }
	get testStates():
		vscode.Event<TestRunStartedEvent |
		TestRunFinishedEvent |
		TestSuiteEvent |
		TestEvent> { return this.testStatesEmitter.event; }
	get autorun(): vscode.Event<void> | undefined { return this.autorunEmitter.event; }
	private disposables: { dispose(): void }[] = [];

	private readonly testsEmitter = new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
	private readonly testStatesEmitter =
		new vscode.EventEmitter<TestRunStartedEvent |
			TestRunFinishedEvent |
			TestSuiteEvent |
			TestEvent>();
	private readonly autorunEmitter = new vscode.EventEmitter<void>();

	private nodesById = new Map<string, SuiteWrapper>();

	private dummySuite: TestSuiteInfo = {
		type: 'suite',
		id: 'root',
		label: 'Fake', // the label of the root node should be the name of the testing framework
		children: [
		]
	};

	constructor(
		public readonly workspace:  vscode.WorkspaceFolder,
		private readonly log: Log
	) {

		this.log.info('Initialising GoTestExplorer adapter');

		this.disposables.push(this.testsEmitter);
		this.disposables.push(this.testStatesEmitter);
		this.disposables.push(this.autorunEmitter);
	}

	public async load(): Promise<void> {
		this.log.info('Loading tests');

		this.testsEmitter.fire(<TestLoadStartedEvent>{ type: 'started' });

		this.nodesById.clear();
		const loadedTests = await this.loadTests();

		this.testsEmitter.fire(<TestLoadFinishedEvent>{ type: 'finished', suite: loadedTests });
	}

	public checkForTests(this: void, e: vscode.TextDocumentChangeEvent) {
		if (!e.document.uri.fsPath.endsWith('_test.go')) {
			return;
		}
	}

	public async run(tests: string[]): Promise<void> {
		this.log.info(`Running tests ${JSON.stringify(tests)}`);

		this.testStatesEmitter.fire(<TestRunStartedEvent>{ type: 'started', tests });

		for (const suiteOrTestId of tests) {
			const node = this.nodesById.get(suiteOrTestId);
			if (node) {
				await this.runNode(node, this.testStatesEmitter);
			}
		}

		this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
	}
	public async debug?(tests: string[]): Promise<void> {
		throw new Error('Method not implemented.');
	}
	public cancel(): void {
		throw new Error('Method not implemented.');
	}

	public dispose(): void {
		this.cancel();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables = [];
	}
	private async runNode(
		node: SuiteWrapper,
		testStatesEmitter: vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>
	): Promise<void> {
		if (node.item.type === 'suite') {
			testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: node.item.id, state: 'running' });

			for (const child of node.item.children) {
				const childNode = this.nodesById.get(child.id);
				await this.runNode(childNode, testStatesEmitter);
			}

			testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: node.item.id, state: 'completed' });
		} else {
			testStatesEmitter.fire(<TestEvent>{ type: 'test', test: node.item.id, state: 'running' });

			const testConfigFns = [node.functionName];
			const fileUri = vscode.Uri.file(node.item.file);
			if (extractInstanceTestName(node.functionName)) {
				testConfigFns.push(...node.testSuites);
			}
			const goConfig = getGoConfig();
			const isMod = await isModSupported(fileUri);
			const testConfig: TestConfig = {
				goConfig,
				dir: path.dirname(node.item.file),
				flags: getTestFlags(goConfig),
				functions: testConfigFns,
				isBenchmark: false,
				isMod,
				applyCodeCoverage: goConfig.get<boolean>('coverOnSingleTest')
			};
			// Remember this config as the last executed test.
			// lastTestConfig = testConfig;
			let state = '';
			if (await goTest(testConfig)) {
				state = 'passed';
			} else {
				state = 'failed';
			}

			testStatesEmitter.fire(<TestEvent>{ type: 'test', test: node.item.id, state });
		}
	}

	private loadTests(): Promise<TestSuiteInfo> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === 'file')[0];
		if (workspaceFolder != null) {
			const srcLocation = workspaceFolder?.uri.path;
			const uri = vscode.Uri.file(srcLocation);
			return Promise.resolve<TestSuiteInfo>(this.walk(uri.fsPath));
		} else {
			return Promise.resolve<TestSuiteInfo>(this.dummySuite);
		}
	}

	private async walk(
		dir: string,
		fileList: TestSuiteInfo = {type: 'suite', id: 'root', label: 'Root', children: []}): Promise<TestSuiteInfo> {
			const files = await fs.readdir(dir);
			for (const file of files) {
				const stat = await fs.stat(path.join(dir, file));

				if (stat.isDirectory()) {
					let child: TestSuiteInfo = {
						type: 'suite',
						id: `${fileList.id}_${file}`,
						label: file,
						children: []
					};
					child = await this.walk(path.join(dir, file), child);
					if (child.children.length > 0) {
						fileList.children.push(child);
						this.nodesById.set(child.id, {item: child, functionName: '', testSuites: []});
					}
				} else {
					if (file.endsWith('_test.go')) {
						const uri = vscode.Uri.file(path.join(dir, file));
						const doc = await vscode.workspace.openTextDocument(uri);
						const testFunctions = await getTestFunctions(doc, null);
						const testSuites = findAllTestSuiteRuns(doc, testFunctions);

						const testSuiteNames = testSuites.map((suite) => {
							return suite.name;
						});
						for (const suite of testSuites) {
							this.log.info(`	suite: ${suite.name}`);
						}
						let suiteTest = '';
						const children: (TestInfo | TestSuiteInfo )[] =
							testFunctions.filter(
								(s) => !testSuites.includes(s)).sort((a, b) => a.name.localeCompare(b.name)).map((symbol) => {
									const rawTestName = extractInstanceTestName(symbol.name);
									const id = `${fileList.id}_${suiteTest.length > 0 ? suiteTest : file}_${symbol.name}`;
									const item: TestInfo = {
										type: 'test',
										description: suiteTest,
										id,
										label: rawTestName ? rawTestName : symbol.name,
										file: path.join(dir, file),
										line: symbol.range.start.line
									};
									this.nodesById.set(id, {item, functionName: symbol.name, testSuites: rawTestName ? testSuiteNames : []});
									return item;
						});
						// const suiteChildren: TestSuiteInfo[] = testSuites.map((symbol) => {
						// 	return {
						// 		type: 'suite',
						// 		id: path.join(dir, file) + symbol.name,
						// 		label: symbol.name,
						// 		children: []
						// 	};
						// });
						// children.push(...suiteChildren);
						const fileItem: TestSuiteInfo = {
							type: 'suite',
							id: path.join(dir, file),
							label: suiteTest.length > 0 ? suiteTest : file,
							children
						};
						fileList.children.push(fileItem);
						this.nodesById.set(fileItem.id, {item: fileItem, functionName: '', testSuites: []});
					}
				}
			}
			return fileList;
	}
}
