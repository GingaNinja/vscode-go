import * as vscode from 'vscode';
import * as path from "path";
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
import { getTestFunctions, findAllTestSuiteRuns, extractInstanceTestName } from './testUtils';
import { byteOffsetAt } from './util';
const fs = require('fs').promises;

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

	private nodesById = new Map<string, TestSuiteInfo | TestInfo>();

	private fakeTestSuite: TestSuiteInfo = {
		type: 'suite',
		id: 'root',
		label: 'Fake', // the label of the root node should be the name of the testing framework
		children: [
			{
				type: 'suite',
				id: 'nested',
				label: 'Nested suite',
				children: [
					{
						type: 'test',
						id: 'test1',
						label: 'Test #1'
					},
					{
						type: 'test',
						id: 'test2',
						label: 'Test #2'
					}
				]
			},
			{
				type: 'test',
				id: 'test3',
				label: 'Test #3'
			},
			{
				type: 'test',
				id: 'test4',
				label: 'Test #4'
			}
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

		const loadedTests = await this.loadTests();
		this.nodesById.clear();
		this.collectNodesById(loadedTests);

		this.testsEmitter.fire(<TestLoadFinishedEvent>{ type: 'finished', suite: loadedTests });
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
		node: TestSuiteInfo | TestInfo,
		testStatesEmitter: vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>
	): Promise<void> {
		if (node.type === 'suite') {
			testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: node.id, state: 'running' });

			for (const child of node.children) {
				await this.runNode(child, testStatesEmitter);
			}

			testStatesEmitter.fire(<TestSuiteEvent>{ type: 'suite', suite: node.id, state: 'completed' });
		} else {
			testStatesEmitter.fire(<TestEvent>{ type: 'test', test: node.id, state: 'running' });

			const testMethodRegex = /^\(([^)]+)\)\.(Test.*)$/;
			const match = node.id.match(testMethodRegex);
	if (!match || match.length !== 3) {
		return null;
	}
	return match[2];
			const testConfigFns = [node.id];
	if (cmd !== 'benchmark' && extractInstanceTestName(testFunctionName)) {
		testConfigFns.push(...findAllTestSuiteRuns(editor.document, testFunctions).map((t) => t.name));
	}

	const isMod = await isModSupported(editor.document.uri);
	const testConfig: TestConfig = {
		goConfig,
		dir: path.dirname(editor.document.fileName),
		flags: getTestFlags(goConfig, args),
		functions: testConfigFns,
		isBenchmark: cmd === 'benchmark',
		isMod,
		applyCodeCoverage: goConfig.get<boolean>('coverOnSingleTest')
	};
	// Remember this config as the last executed test.
	lastTestConfig = testConfig;
	return goTest(testConfig);


			testStatesEmitter.fire(<TestEvent>{ type: 'test', test: node.id, state: 'passed' });
		}
	}

	private loadTests(): Promise<TestSuiteInfo> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === 'file')[0];
		if (workspaceFolder != null) {
			const srcLocation = workspaceFolder?.uri.path;
			const uri = vscode.Uri.file(srcLocation);
			return Promise.resolve<TestSuiteInfo>(this.walk(uri.fsPath));
		} else {
			return Promise.resolve<TestSuiteInfo>(this.fakeTestSuite);
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
					}
				} else {
					if (file.endsWith('_test.go')) {
						const uri = vscode.Uri.file(path.join(dir, file));
						const doc = await vscode.workspace.openTextDocument(uri);
						const testFunctions = await getTestFunctions(doc, null);
						const testSuites = findAllTestSuiteRuns(doc, testFunctions);

						for (const suite of testSuites) {
							this.log.info(`	suite: ${suite.name}`);
							let offset = byteOffsetAt(doc, suite.range.start);
							this.log.info(`offset: ${offset} - file: ${doc.fileName}`);
						}
						let suiteTest = '';
						let children: (TestInfo | TestSuiteInfo )[] =
							testFunctions.filter(
								(s) => !testSuites.includes(s)).sort((a, b) => a.name.localeCompare(b.name)).map((symbol) => {
									const rawTestName = extractInstanceTestName(symbol.name);
									return {
										type: 'test',
										description: suiteTest,
										id: `${fileList.id}_${suiteTest.length > 0 ? suiteTest : file}_${symbol.name}`,
										label: rawTestName,
										file: path.join(dir, file),
										line: symbol.range.start.line
									};
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

						fileList.children.push(
							{
								type: 'suite',
								id: path.join(dir, file),
								label: suiteTest.length > 0 ? suiteTest : file,
								children
							}
						);
					}
				}
			}
			return fileList;
	}

	private collectNodesById(info: TestSuiteInfo | TestInfo): void {
		this.nodesById.set(info.id, info);
		if (info.type === 'suite') {
			for (const child of info.children) {
				this.collectNodesById(child);
			}
		}
	}

}
